// Register the shared Git transport before any publication or run-lease consumer.
// oxfmt-ignore
import {
  SESSION_KEY,
  installGitHubPublicationTestHarness,
  persistPublicationTestSession,
} from "./github-publication.test-support.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  applySessionEntryLifecycleMutation,
  deleteSessionEntryLifecycle,
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  readExactSessionEntryRow,
  writeSessionEntry,
} from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import { readGitHubPublicationSessionLifecycle } from "../state/github-publication-session-lifecycles.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { readUserGitHubConnection } from "../state/user-github-connections.js";
import { readPersonalGitHubPublicationInDatabase } from "./github-personal-publication-store.worker.js";
import {
  callPersonalPublicationRpc,
  createPersonalPublicationFixture,
  personalPublicationAccount as account,
  preparePersonalPublicationFixtureAction,
} from "./github-personal-publication.test-support.js";

function holdReceiptDeletion(afterPreparation?: () => Promise<void>) {
  const waiting = createDeferredCore();
  const release = createDeferredCore();
  const runOperation = stateWorker.runOpenClawStateWorkerOperation;
  const holdReceipt = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
    new Proxy(runOperation, {
      apply(
        target,
        receiver,
        [workerContext, operation, options]: Parameters<typeof runOperation>,
      ) {
        return Reflect.apply(target, receiver, [
          workerContext,
          (scope: Parameters<typeof operation>[0]) =>
            operation({
              execute: new Proxy(scope.execute, {
                async apply(execute, executeReceiver, args: Parameters<typeof scope.execute>) {
                  if (args[0].type === "githubPublication.deleteSessionReceipts") {
                    waiting.resolve();
                    await release.promise;
                  }
                  const result = await Reflect.apply(execute, executeReceiver, args);
                  if (args[0].type === "githubPublication.prepareSessionReceiptDeletion") {
                    await afterPreparation?.();
                  }
                  return result;
                },
              }),
            }),
          options,
        ]);
      },
    }),
  );
  return { waiting, release, restore: () => holdReceipt.mockRestore() };
}

async function waitForReceiptDeletion(waiting: Promise<void>, deletion: Promise<unknown>) {
  await Promise.race([
    waiting,
    deletion.then((outcome) => {
      throw new Error("Session deletion settled before receipt cleanup reached its worker", {
        cause: outcome,
      });
    }),
  ]);
}

describe("personal publication session lifecycle", () => {
  installGitHubPublicationTestHarness();
  let fixture: Awaited<ReturnType<typeof createPersonalPublicationFixture>>;
  beforeEach(async () => {
    fixture = await createPersonalPublicationFixture();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const request = () => ({
    sessionKey: SESSION_KEY,
    idempotencyKey: "personal-publish",
    selection: { source: "personal" as const, generation: fixture.generation, account },
  });
  const rpc = (method: string, params?: Record<string, unknown>) =>
    callPersonalPublicationRpc(
      { client: fixture.client, context: fixture.context, coordinator: fixture.coordinator },
      method,
      params,
    );

  async function publishReceipt() {
    const { owner, client, context, coordinator } = fixture;
    const session = await persistPublicationTestSession();
    const action = await preparePersonalPublicationFixtureAction({ client, context });
    const published = await coordinator.requestPersonalForSessionV2(request(), action);
    const receipt = readPersonalGitHubPublicationInDatabase(openOpenClawStateDatabase().db, owner, {
      requestId: published.requestId,
    });
    expect(receipt?.status).toBe("published");
    const binding = { publicationKind: "personal" as const, requestId: published.requestId };
    return {
      session,
      published,
      receipt,
      binding,
      lifecycle: readGitHubPublicationSessionLifecycle(binding),
    };
  }

  it("preserves repository receipts when a session is recreated before receipt deletion admission", async () => {
    const { owner } = fixture;
    const { session, published, receipt, binding, lifecycle } = await publishReceipt();
    const repositories = getSessionRepositoryWorkspaceStore();
    const workspace = await repositories.create({
      agentId: "main",
      sessionKey: SESSION_KEY,
      url: "https://github.com/example/receipt-guard.git",
      requestedRef: "main",
      assertCurrent: () => {},
    });
    const original = session.read();
    const { waiting, release, restore } = holdReceiptDeletion();
    const deletion = applySessionEntryLifecycleMutation({
      agentId: "main",
      storePath: session.storePath,
      removals: [{ sessionKey: SESSION_KEY, expectedEntry: original }],
      skipMaintenance: true,
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      await waitForReceiptDeletion(waiting.promise, deletion);
      expect(session.read()).toBeUndefined();
      expect(
        readPersonalGitHubPublicationInDatabase(openOpenClawStateDatabase().db, owner, {
          requestId: published.requestId,
        }),
      ).toEqual(receipt);
      const successor = {
        ...original,
        sessionId: "receipt-guard-successor",
        lifecycleRevision: "receipt-guard-successor-generation",
        updatedAt: Date.now(),
      };
      replaceSessionEntrySync(
        { agentId: "main", storePath: session.storePath, sessionKey: SESSION_KEY },
        successor,
      );
      release.resolve();
      expect(await deletion).toMatchObject({
        ok: false,
        error: expect.objectContaining({
          message: expect.stringContaining("Repository workspace session changed before deletion"),
        }),
      });
      expect(session.read()).toMatchObject(successor);
      expect(await repositories.get(workspace.workspaceId)).toEqual(workspace);
      expect(
        readPersonalGitHubPublicationInDatabase(openOpenClawStateDatabase().db, owner, {
          requestId: published.requestId,
        }),
      ).toEqual(receipt);
      expect(readGitHubPublicationSessionLifecycle(binding)).toEqual(lifecycle);
    } finally {
      release.resolve();
      await deletion;
      restore();
    }
  });

  it("preserves receipts and repository ownership when an owner write crosses the native receipt grant", async () => {
    const { owner } = fixture;
    const { session, published, receipt, binding, lifecycle } = await publishReceipt();
    expect(lifecycle).toBeDefined();
    const repositories = getSessionRepositoryWorkspaceStore();
    const workspace = await repositories.create({
      agentId: "main",
      sessionKey: SESSION_KEY,
      url: "https://github.com/example/receipt-grant.git",
      assertCurrent: () => {},
    });
    const original = session.read();
    const successor = {
      ...original,
      sessionId: "receipt-successor",
      lifecycleRevision: "receipt-successor-generation",
      updatedAt: Date.now(),
    };
    // Admit the competing agent writer before receipt cleanup locks the shared-state database.
    const database = openOpenClawAgentDatabase({
      agentId: "main",
      path: resolveSqliteTargetFromSessionStorePath(session.storePath, { agentId: "main" }).path,
    });
    let injected = false;
    let receiptAdmitted = false;
    let nativeAbsent = false;
    // A competing writer must not inherit the guarded reader's artifact-preserving context.
    const inWriterContext = AsyncLocalStorage.snapshot();
    const held = holdReceiptDeletion();
    const admission = probe.admission(operationAdmission, (nativeRequest, grant, admit) => {
      const facts = nativeRequest.facts;
      if (
        !injected &&
        receiptAdmitted &&
        nativeRequest.stage === "commit" &&
        (facts === undefined ||
          (isRecord(facts) &&
            facts.kind === "session-entry-current" &&
            facts.domainFacts === undefined &&
            isRecord(facts.source) &&
            facts.source.sessionKey === SESSION_KEY))
      ) {
        nativeAbsent = isRecord(facts) && facts.entry === undefined;
        admit(nativeRequest, () => {
          inWriterContext(() => {
            expect(readExactSessionEntryRow(database, SESSION_KEY)).toBeUndefined();
            runSqliteImmediateTransactionSync(database.db, () =>
              writeSessionEntry(database, SESSION_KEY, successor),
            );
          });
          injected = true;
          return grant();
        });
        return;
      }
      admit(nativeRequest, grant);
    });
    const deletion = applySessionEntryLifecycleMutation({
      agentId: "main",
      storePath: session.storePath,
      removals: [{ sessionKey: SESSION_KEY, expectedEntry: original }],
      skipMaintenance: true,
    }).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    try {
      await waitForReceiptDeletion(held.waiting.promise, deletion);
      receiptAdmitted = true;
      held.release.resolve();
      const outcome = await deletion;
      expect(injected, String(outcome.error)).toBe(true);
      expect(session.read()).toEqual(successor);
      expect(await repositories.get(workspace.workspaceId)).toEqual(workspace);
      expect(
        readPersonalGitHubPublicationInDatabase(openOpenClawStateDatabase().db, owner, {
          requestId: published.requestId,
        }),
      ).toEqual(receipt);
      expect(readGitHubPublicationSessionLifecycle(binding)).toEqual(lifecycle);
      expect(nativeAbsent).toBe(true);
      expect(outcome.error).toMatchObject({
        message: expect.stringContaining(
          "Session currency changed while awaiting its native grant",
        ),
      });
    } finally {
      held.release.resolve();
      await deletion;
      held.restore();
      admission.mockRestore();
    }
  });

  it("preserves a same-key successor receipt while direct deletion removes historical receipts", async () => {
    const { owner, client, context, coordinator, placements } = fixture;
    const {
      session,
      published: historical,
      receipt: oldReceipt,
      binding: oldBinding,
      lifecycle: oldLifecycle,
    } = await publishReceipt();
    await session.reset(placements);
    const original = session.read();
    expect(
      readPersonalGitHubPublicationInDatabase(openOpenClawStateDatabase().db, owner, {
        requestId: historical.requestId,
      }),
    ).toEqual(oldReceipt);
    expect(oldLifecycle?.lifecycle_revision).not.toBe(original.lifecycleRevision);
    expect(
      await getSessionRepositoryWorkspaceStore().find({ agentId: "main", sessionKey: SESSION_KEY }),
    ).toBeUndefined();

    const lateReceipt = createDeferredCore<string>();
    const { waiting, release, restore } = holdReceiptDeletion(async () => {
      expect(session.read()).toEqual(original);
      const lateAction = await preparePersonalPublicationFixtureAction({ client, context });
      const late = await coordinator.requestPersonalForSessionV2(
        { ...request(), idempotencyKey: "direct-receipt-late-original" },
        lateAction,
      );
      expect(late.requestId).not.toBe(historical.requestId);
      expect(
        readPersonalGitHubPublicationInDatabase(openOpenClawStateDatabase().db, owner, {
          requestId: late.requestId,
        }),
      ).toMatchObject({
        status: "published",
        session_id: original.sessionId,
      });
      expect(
        readGitHubPublicationSessionLifecycle({
          publicationKind: "personal",
          requestId: late.requestId,
        })?.lifecycle_revision,
      ).toBe(original.lifecycleRevision);
      lateReceipt.resolve(late.requestId);
    });
    const deletion = deleteSessionEntryLifecycle({
      agentId: "main",
      storePath: session.storePath,
      target: { canonicalKey: SESSION_KEY, storeKeys: [SESSION_KEY] },
      expectedSessionId: original.sessionId,
      archiveTranscript: false,
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      await waitForReceiptDeletion(waiting.promise, deletion);
      const lateRequestId = await lateReceipt.promise;
      expect(session.read()).toBeUndefined();
      const successor = {
        ...original,
        lifecycleRevision: "direct-receipt-successor-generation",
        updatedAt: Date.now(),
      };
      replaceSessionEntrySync(
        { agentId: "main", storePath: session.storePath, sessionKey: SESSION_KEY },
        successor,
      );
      const successorAction = await preparePersonalPublicationFixtureAction({ client, context });
      const published = await coordinator.requestPersonalForSessionV2(
        { ...request(), idempotencyKey: "direct-receipt-successor" },
        successorAction,
      );
      expect(published.requestId).not.toBe(historical.requestId);
      const receipt = readPersonalGitHubPublicationInDatabase(
        openOpenClawStateDatabase().db,
        owner,
        { requestId: published.requestId },
      );
      const binding = { publicationKind: "personal" as const, requestId: published.requestId };
      const lifecycle = readGitHubPublicationSessionLifecycle(binding);
      expect(receipt).toMatchObject({ status: "published", session_id: successor.sessionId });
      expect(lifecycle?.lifecycle_revision).toBe(successor.lifecycleRevision);
      release.resolve();
      const outcome = await deletion;
      expect(outcome).toMatchObject({ ok: true, value: { deleted: true } });
      expect(
        readPersonalGitHubPublicationInDatabase(openOpenClawStateDatabase().db, owner, {
          requestId: published.requestId,
        }),
      ).toEqual(receipt);
      expect(readGitHubPublicationSessionLifecycle(binding)).toEqual(lifecycle);
      expect(session.read()).toMatchObject(successor);
      expect(
        readPersonalGitHubPublicationInDatabase(openOpenClawStateDatabase().db, owner, {
          requestId: historical.requestId,
        }),
      ).toBeUndefined();
      expect(readGitHubPublicationSessionLifecycle(oldBinding)).toBeUndefined();
      expect(
        readPersonalGitHubPublicationInDatabase(openOpenClawStateDatabase().db, owner, {
          requestId: lateRequestId,
        }),
      ).toBeUndefined();
      expect(
        readGitHubPublicationSessionLifecycle({
          publicationKind: "personal",
          requestId: lateRequestId,
        }),
      ).toBeUndefined();
    } finally {
      release.resolve();
      await deletion;
      restore();
    }
  });

  it("retains logical-session receipts across archive and reset, then removes them through permanent deletion", async () => {
    const { owner, generation, placements } = fixture;
    const installed = new Map<string, unknown>();
    onTestFinished(
      githubPublicationReceipts.subscribeFacts((change) => {
        if (change.kind === "committed") {
          for (const [key, fact] of change.receipt.facts) {
            installed.set(key, fact);
          }
        }
      }),
    );
    const {
      session,
      published: result,
      receipt,
      binding,
      lifecycle: originalLifecycle,
    } = await publishReceipt();
    const { title: _title, body: _body, next_action: _nextAction, ...authority } = receipt!;
    expect(installed.get(JSON.stringify(["personal", result.requestId]))).toEqual({
      kind: "postimage",
      value: authority,
    });
    expect(installed.get(JSON.stringify(["personal-lifecycle", result.requestId]))).toEqual({
      kind: "postimage",
      value: { ...originalLifecycle, publication_kind: "personal", request_id: result.requestId },
    });
    const lifecycle_revision = session.read().lifecycleRevision;
    expect(originalLifecycle).toEqual({ lifecycle_revision, requester_authority_json: null });
    await session.reset(placements);
    expect(
      readPersonalGitHubPublicationInDatabase(openOpenClawStateDatabase().db, owner, {
        requestId: result.requestId,
      }),
    ).toEqual(receipt);
    expect(
      (
        await rpc("sessions.github.status", {
          requestId: result.requestId,
          sessionKey: SESSION_KEY,
        })
      )[1],
    ).toMatchObject({ result: { status: "published" }, confirmation: null });
    const storePath = session.storePath;
    await patchSessionEntryCore({ agentId: "main", sessionKey: SESSION_KEY, storePath }, () => ({
      archivedAt: Date.now(),
    }));
    const target = { canonicalKey: SESSION_KEY, storeKeys: [SESSION_KEY] };
    expect(
      readPersonalGitHubPublicationInDatabase(openOpenClawStateDatabase().db, owner, {
        requestId: result.requestId,
      }),
    ).toEqual(receipt);
    expect(readGitHubPublicationSessionLifecycle(binding)).toEqual(originalLifecycle);
    const lostReply = probe.command(stateWorker, async (command, options, scope) => {
      const outcome = await scope.execute(command, options);
      if (command.type === "githubPublication.deleteSessionReceipts") {
        throw new Error("committed receipt cleanup reply lost");
      }
      return outcome;
    });
    await expect(
      deleteSessionEntryLifecycle({
        agentId: "main",
        storePath,
        target,
        archiveTranscript: false,
      }),
    ).rejects.toThrow("committed receipt cleanup reply lost");
    lostReply.mockRestore();
    expect(
      readPersonalGitHubPublicationInDatabase(openOpenClawStateDatabase().db, owner, {
        requestId: result.requestId,
      }),
    ).toBeUndefined();
    expect(readGitHubPublicationSessionLifecycle(binding)).toBeUndefined();
    expect(installed.get(JSON.stringify(["personal", result.requestId]))).toEqual({
      kind: "absent",
    });
    expect(installed.get(JSON.stringify(["personal-lifecycle", result.requestId]))).toEqual({
      kind: "absent",
    });
    expect(readUserGitHubConnection(owner)?.generation).toBe(generation);
  });
});
