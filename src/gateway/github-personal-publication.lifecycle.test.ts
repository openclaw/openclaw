import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySessionEntryLifecycleMutation,
  deleteSessionEntryLifecycle,
  patchSessionEntryCore,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { readGitHubPublicationSessionLifecycle } from "../state/github-publication-session-lifecycles.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { readUserGitHubConnection } from "../state/user-github-connections.js";
import { readPersonalGitHubPublication } from "./github-personal-publication-store.js";
import {
  callPersonalPublicationRpc,
  createPersonalPublicationFixture,
  personalPublicationAccount as account,
} from "./github-personal-publication.test-support.js";
import {
  SESSION_KEY,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  persistPublicationTestSession,
} from "./github-publication.test-support.js";
import { preparePersonalGitHubSessionAction } from "./server-methods/github-personal-authorization.js";

const mocks = githubPublicationTestMocks();

vi.mock("../agents/worktrees/git-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/worktrees/git-lock.js")>()),
  lockWorktreeForProcess: vi.fn(async () => undefined),
  unlockWorktree: vi.fn(async () => undefined),
}));
vi.mock("../process/exec.js", () => ({
  runCommandBuffered: (
    ...args: Parameters<typeof import("../process/exec.js").runCommandBuffered>
  ) => mocks.runCommand(...args),
}));

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

  it("preserves repository receipts when a session is recreated before receipt deletion admission", async () => {
    const { owner, client, context, coordinator } = fixture;
    const session = await persistPublicationTestSession();
    const action = preparePersonalGitHubSessionAction(
      { client, context },
      { sessionKey: SESSION_KEY },
    );
    const published = await coordinator.requestPersonalForSession(request(), action);
    const receipt = readPersonalGitHubPublication(owner, { requestId: published.requestId });
    expect(receipt?.status).toBe("published");
    const binding = { publicationKind: "personal" as const, requestId: published.requestId };
    const lifecycle = readGitHubPublicationSessionLifecycle(binding);
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
      await Promise.race([
        waiting.promise,
        deletion.then((outcome) => {
          throw new Error("Session deletion settled before receipt cleanup reached its worker", {
            cause: outcome,
          });
        }),
      ]);
      expect(session.read()).toBeUndefined();
      expect(readPersonalGitHubPublication(owner, { requestId: published.requestId })).toEqual(
        receipt,
      );
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
      expect(readPersonalGitHubPublication(owner, { requestId: published.requestId })).toEqual(
        receipt,
      );
      expect(readGitHubPublicationSessionLifecycle(binding)).toEqual(lifecycle);
    } finally {
      release.resolve();
      await deletion;
      restore();
    }
  });

  it("preserves receipts and repository ownership when a foreign write crosses the native receipt grant", async () => {
    const { owner, client, context, coordinator } = fixture;
    const session = await persistPublicationTestSession();
    const action = preparePersonalGitHubSessionAction(
      { client, context },
      { sessionKey: SESSION_KEY },
    );
    const published = await coordinator.requestPersonalForSession(request(), action);
    const receipt = readPersonalGitHubPublication(owner, { requestId: published.requestId });
    expect(receipt?.status).toBe("published");
    const binding = { publicationKind: "personal" as const, requestId: published.requestId };
    const lifecycle = readGitHubPublicationSessionLifecycle(binding);
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
      sessionId: "foreign-receipt-successor",
      lifecycleRevision: "foreign-receipt-generation",
      updatedAt: Date.now(),
    };
    const databasePath = resolveSqliteTargetFromSessionStorePath(session.storePath, {
      agentId: "main",
    }).path;
    if (!databasePath) {
      throw new Error("Receipt fixture has no physical session database");
    }
    const peer = new DatabaseSync(databasePath);
    let injected = false;
    let receiptAdmitted = false;
    let nativeAbsent = false;
    const held = holdReceiptDeletion();
    const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
    const admission = vi
      .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment) =>
        createAdmission((nativeRequest, grant) => {
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
              expect(
                peer
                  .prepare("SELECT session_key FROM session_nodes WHERE session_key = ?")
                  .get(SESSION_KEY),
              ).toBeUndefined();
              peer.exec("BEGIN IMMEDIATE");
              try {
                peer
                  .prepare(
                    "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
                  )
                  .run(
                    SESSION_KEY,
                    successor.sessionId,
                    JSON.stringify(successor),
                    successor.updatedAt,
                  );
                peer
                  .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
                  .run(SESSION_KEY);
                peer.exec("COMMIT");
              } catch (error) {
                peer.exec("ROLLBACK");
                throw error;
              }
              injected = true;
              return grant();
            });
            return;
          }
          admit(nativeRequest, grant);
        }, attachment),
      );
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
      await Promise.race([
        held.waiting.promise,
        deletion.then((outcome) => {
          throw new Error("Session deletion settled before its receipt grant", { cause: outcome });
        }),
      ]);
      receiptAdmitted = true;
      held.release.resolve();
      const outcome = await deletion;
      expect(injected).toBe(true);
      expect(
        peer.prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?").get(SESSION_KEY),
      ).toEqual({ entry_json: JSON.stringify(successor) });
      expect(await repositories.get(workspace.workspaceId)).toEqual(workspace);
      expect(readPersonalGitHubPublication(owner, { requestId: published.requestId })).toEqual(
        receipt,
      );
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
      peer.close();
    }
  });

  it("preserves a same-key successor receipt while direct deletion removes historical receipts", async () => {
    const { owner, client, context, coordinator, placements } = fixture;
    const session = await persistPublicationTestSession();
    const action = preparePersonalGitHubSessionAction(
      { client, context },
      { sessionKey: SESSION_KEY },
    );
    const historical = await coordinator.requestPersonalForSession(request(), action);
    const oldReceipt = readPersonalGitHubPublication(owner, { requestId: historical.requestId });
    expect(oldReceipt?.status).toBe("published");
    const oldBinding = { publicationKind: "personal" as const, requestId: historical.requestId };
    const oldLifecycle = readGitHubPublicationSessionLifecycle(oldBinding);
    await session.reset(placements);
    const original = session.read();
    expect(readPersonalGitHubPublication(owner, { requestId: historical.requestId })).toEqual(
      oldReceipt,
    );
    expect(oldLifecycle?.lifecycle_revision).not.toBe(original.lifecycleRevision);
    expect(
      await getSessionRepositoryWorkspaceStore().find({ agentId: "main", sessionKey: SESSION_KEY }),
    ).toBeUndefined();

    const lateReceipt = createDeferredCore<string>();
    const { waiting, release, restore } = holdReceiptDeletion(async () => {
      expect(session.read()).toEqual(original);
      const lateAction = preparePersonalGitHubSessionAction(
        { client, context },
        { sessionKey: SESSION_KEY },
      );
      const late = await coordinator.requestPersonalForSession(
        { ...request(), idempotencyKey: "direct-receipt-late-original" },
        lateAction,
      );
      expect(late.requestId).not.toBe(historical.requestId);
      expect(readPersonalGitHubPublication(owner, { requestId: late.requestId })).toMatchObject({
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
      await Promise.race([
        waiting.promise,
        deletion.then((outcome) => {
          throw new Error("Direct deletion settled before receipt cleanup reached its worker", {
            cause: outcome,
          });
        }),
      ]);
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
      const successorAction = preparePersonalGitHubSessionAction(
        { client, context },
        { sessionKey: SESSION_KEY },
      );
      const published = await coordinator.requestPersonalForSession(
        { ...request(), idempotencyKey: "direct-receipt-successor" },
        successorAction,
      );
      expect(published.requestId).not.toBe(historical.requestId);
      const receipt = readPersonalGitHubPublication(owner, { requestId: published.requestId });
      const binding = { publicationKind: "personal" as const, requestId: published.requestId };
      const lifecycle = readGitHubPublicationSessionLifecycle(binding);
      expect(receipt).toMatchObject({ status: "published", session_id: successor.sessionId });
      expect(lifecycle?.lifecycle_revision).toBe(successor.lifecycleRevision);
      release.resolve();
      const outcome = await deletion;
      expect(outcome).toMatchObject({ ok: true, value: { deleted: true } });
      expect(readPersonalGitHubPublication(owner, { requestId: published.requestId })).toEqual(
        receipt,
      );
      expect(readGitHubPublicationSessionLifecycle(binding)).toEqual(lifecycle);
      expect(session.read()).toMatchObject(successor);
      expect(
        readPersonalGitHubPublication(owner, { requestId: historical.requestId }),
      ).toBeUndefined();
      expect(readGitHubPublicationSessionLifecycle(oldBinding)).toBeUndefined();
      expect(readPersonalGitHubPublication(owner, { requestId: lateRequestId })).toBeUndefined();
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
    const { owner, client, context, coordinator, generation, placements } = fixture;
    const session = await persistPublicationTestSession();
    const action = preparePersonalGitHubSessionAction(
      { client, context },
      { sessionKey: SESSION_KEY },
    );
    const result = await coordinator.requestPersonalForSession(request(), action);
    const receipt = readPersonalGitHubPublication(owner, { requestId: result.requestId });
    expect(receipt?.status).toBe("published");
    const binding = { publicationKind: "personal" as const, requestId: result.requestId };
    const originalLifecycle = readGitHubPublicationSessionLifecycle(binding);
    const lifecycle_revision = session.read().lifecycleRevision;
    expect(originalLifecycle).toEqual({ lifecycle_revision, requester_authority_json: null });
    await session.reset(placements);
    expect(readPersonalGitHubPublication(owner, { requestId: result.requestId })).toEqual(receipt);
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
    expect(readPersonalGitHubPublication(owner, { requestId: result.requestId })).toEqual(receipt);
    expect(readGitHubPublicationSessionLifecycle(binding)).toEqual(originalLifecycle);
    await deleteSessionEntryLifecycle({
      agentId: "main",
      storePath,
      target,
      archiveTranscript: false,
    });
    expect(readPersonalGitHubPublication(owner, { requestId: result.requestId })).toBeUndefined();
    expect(readGitHubPublicationSessionLifecycle(binding)).toBeUndefined();
    expect(readUserGitHubConnection(owner)?.generation).toBe(generation);
  });
});
