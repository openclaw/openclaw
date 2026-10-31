import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  ErrorCodes,
  errorShape,
  type SessionsForkResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveInternalSessionEffectsIdentity } from "../../config/sessions/internal-session-key.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry-store.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { memorySessionActorOwners } from "../../config/sessions/session-actor-memory-owner.js";
import * as memoryStorage from "../../config/sessions/session-actor-memory-storage.js";
import { readSessionColdTranscript } from "../../config/sessions/session-cold-storage-state.js";
import { runSessionColdStorageMaintenance } from "../../config/sessions/session-cold-storage.js";
import {
  readSessionEntryReadOnlyInWorker,
  readSessionEntrySummariesInWorker,
} from "../../config/sessions/session-entry-read-runtime.js";
import { addSessionMember } from "../../config/sessions/session-sharing-store.js";
import { removeSessionMember } from "../../config/sessions/session-sharing-store.native.js";
import { waitForSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { createRuntimeAgent } from "../../plugins/runtime/runtime-agent.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import * as sessionController from "../../sessions/session-controller.lifecycle.js";
import * as upstreamReads from "../../sessions/session-upstream-links-runtime.js";
import { upsertSessionUpstreamLink } from "../../sessions/session-upstream-links.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as storeWriterQueue from "../../shared/store-writer-queue.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseRuntime,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { sharingPolicyClient } from "../session-sharing.test-utils.js";
import * as sessionEntryReader from "../session-utils-store-worker.js";
import * as repositoryCheckpoints from "../worker-environments/session-repository-checkpoints.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";
import {
  expectCutFailure as expectFailure,
  expectCutReply,
  holdLifecycle,
  invokeHandler,
  installHarness,
} from "./sessions-rewind.handler.test-support.js";
import {
  cfg,
  messageCutContext as context,
  invokeMessageCut,
  mutationMethods,
  mutationParams,
  readMutationStorage,
  seedMessageCutSource,
  useMessageCutStorageFixture,
  type SourceScope,
} from "./sessions-rewind.storage.test-support.js";
import { sessionSharingHandlers } from "./sessions-sharing.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

useMessageCutStorageFixture();

function withStorage(
  run: (state: OpenClawTestState) => Promise<void>,
  prepareProfileCatalog = false,
) {
  return withOpenClawTestState(
    { label: "message-cut-storage", prepareProfileCatalog },
    async (state) => {
      await state.writeConfig(cfg);
      await run(state);
    },
  );
}

async function authorizeMemberFork(scope: SourceScope) {
  const client = {
    authenticatedUserId: "member@example.com",
    authenticatedUserProfile: {
      profileId: "member",
      displayName: "Member",
      hasAvatar: false,
      updatedAt: 1,
    },
    connect: { role: "operator", scopes: ["operator.write"] },
  } as GatewayClient;
  const requestContext = context();
  await initializeSessionReadContext(requestContext);
  const request = {
    client,
    method: "sessions.fork",
    requestParams: mutationParams("sessions.fork", scope.sessionKey),
    context: requestContext,
  };
  const admission = await resolveSessionMutationAuthorizationAsync(request);
  expect(admission.error).toBeNull();
  const authorization = expectDefined(admission.authorization, "source participation authority");
  return {
    authorization,
    request,
    options: { client, context: requestContext, sessionMutationAuthorization: authorization },
  };
}

async function seedMemberSource() {
  const scope = await seedMessageCutSource();
  await addSessionMember(scope, {
    identityId: "member",
    addedBy: "owner",
    expectedSessionId: scope.sessionId,
  });
  return scope;
}

it.each(mutationMethods)(
  "rejects %s while its source initializer is still running",
  async (method) => {
    await withStorage(async () => {
      setRuntimeConfigSnapshot(cfg);
      const runtime = createRuntimeAgent();
      const key = "agent:main:dashboard:initializing-source";
      const initialized = createDeferredCore();
      const release = createDeferredCore();
      let source: SourceScope | undefined;
      const creation = runtime.session.createSessionEntry({
        cfg,
        key,
        initialEntry: { agentHarnessId: "test-harness" },
        afterCreate: async (entry) => {
          source = { agentId: entry.agentId, sessionKey: key, sessionId: entry.sessionId };
          await appendTranscriptMessage(source, {
            eventId: "user-2",
            parentId: null,
            message: { role: "user", content: "Pending history" },
          });
          await appendTranscriptMessage(source, {
            eventId: "alternate-user",
            parentId: null,
            message: { role: "user", content: "Alternate pending history" },
          });
          await appendTranscriptEvent(source, {
            type: "leaf",
            id: "pending-leaf",
            parentId: "alternate-user",
            targetId: "user-2",
          });
          await waitForSessionTranscriptIndexReconcile(
            toDatabaseOptions(resolveSqliteScope(source)),
          );
          initialized.resolve();
          await release.promise;
        },
      });
      const creationResult = creation.then(
        (created) => ({ created }),
        (error: unknown) => ({ error }),
      );
      let mutation: ReturnType<typeof invokeMessageCut> | undefined;
      try {
        await initialized.promise;
        const scope = expectDefined(source, "pending source");
        const before = await readMutationStorage(scope);
        mutation = invokeMessageCut(method, scope);
        // The initializer remains blocked: rejection must not wait on its lifecycle fence.
        await vi.waitFor(() => expect(mutation?.respond).toHaveBeenCalled());
        expect(await mutation.error).toBeUndefined();
        expectFailure(mutation.respond, {
          code: ErrorCodes.UNAVAILABLE,
          message: expect.stringContaining("initializing"),
        });
        expect(await readMutationStorage(scope)).toEqual(before);
      } finally {
        release.resolve();
        await creationResult;
        await mutation?.error;
      }
      expect(await creationResult).toHaveProperty("created.entry.sessionId", source?.sessionId);
    });
  },
);

it.each([
  { kind: "visible", hidden: false, identified: false },
  { kind: "visible to an identified reader", hidden: false, identified: true },
  { kind: "hidden internal-effects", hidden: true, identified: true },
])(
  "lists $kind session branches without decoding saved snapshots",
  async ({ hidden, identified }) => {
    await withStorage(async () => {
      const identity = hidden
        ? resolveInternalSessionEffectsIdentity({ agentId: "main", runId: "branch-list-hidden" })
        : undefined;
      const scope = await seedMessageCutSource(false, identity);
      const selectedPrompt = "selected-session-unused-skill-prompt".repeat(128);
      await upsertSessionEntryCore(scope, {
        sessionId: scope.sessionId,
        updatedAt: 1,
        skillsSnapshot: { prompt: selectedPrompt, skills: [] },
      });
      const unrelatedPrompt = "unrelated-session-skill-prompt".repeat(128);
      for (let index = 0; index < 3; index += 1) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: `agent:main:unrelated-${index}` },
          {
            sessionId: `unrelated-${index}`,
            updatedAt: index + 1,
            skillsSnapshot: { prompt: unrelatedPrompt, skills: [] },
          },
        );
      }
      const parse = vi.spyOn(JSON, "parse");
      const reads = vi.spyOn(sessionEntryReader, "loadGatewaySessionEntryReadOnlyInWorker");
      using _ = { [Symbol.dispose]: () => parse.mockRestore() };
      const respond = await invokeHandler("sessions.branches.list", undefined, {
        params: { sessionKey: scope.sessionKey },
        client: identified ? sharingPolicyClient({ user: "branch-reader" }) : null,
      });
      expectCutReply(respond, {
        branches: hidden
          ? []
          : [
              expect.objectContaining({
                leafEntryId: "user-2",
                active: true,
                headline: "What did I say?",
                messageCount: 3,
              }),
              expect.objectContaining({
                leafEntryId: "alternate-user",
                active: false,
                headline: "An alternate branch.",
                messageCount: 1,
              }),
            ],
      });
      expect(parse.mock.calls.filter(([text]) => text.includes(unrelatedPrompt))).toHaveLength(0);
      expect(parse.mock.calls.filter(([text]) => text.includes(selectedPrompt))).toHaveLength(0);
      expect(reads).toHaveBeenCalledTimes(1);
    }, true);
  },
);

async function revokeDuringWriterWait(
  scope: SourceScope,
  invoke: () => ReturnType<typeof invokeMessageCut>,
  revoke: () => void | Promise<void>,
) {
  const resolved = resolveSqliteScope(scope);
  await waitForSessionTranscriptIndexReconcile(toDatabaseOptions(resolved));
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const queued = createDeferredCore();
  const heldWriter = runExclusiveSqliteSessionWrite(
    resolved,
    () =>
      withOpenClawAgentDatabaseRuntime(toDatabaseOptions(resolved), async () => {
        // Admit the native fault-injection handle before signaling the held writer.
        entered.resolve();
        await release.promise;
      }),
    "session.transcript.batch",
  );
  await entered.promise;
  const enqueueWrite = storeWriterQueue.runQueuedStoreWrite;
  const writer = vi.spyOn(storeWriterQueue, "runQueuedStoreWrite").mockImplementation((params) => {
    const pending = enqueueWrite(params);
    if (
      params.label === "agent database write admission" &&
      params.storePath === resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved))
    ) {
      queued.resolve();
    }
    return pending;
  });
  let mutation: ReturnType<typeof invokeMessageCut> | undefined;
  try {
    mutation = invoke();
    await awaitGateBeforeSettlement(
      queued.promise,
      mutation.error,
      "Message cut settled before joining its physical writer queue",
    );
    await revoke();
  } finally {
    writer.mockRestore();
    release.resolve();
    await heldWriter;
    await mutation?.error;
  }
  return expectDefined(mutation, "queued message cut");
}

async function revokeWithPublicLifecyclePredecessor(
  scope: SourceScope,
  requestContext: GatewayRequestContext,
  invoke: () => ReturnType<typeof invokeMessageCut>,
) {
  const storePath = resolveSessionStorePathCore(undefined, { agentId: scope.agentId });
  const { release, settled: heldLifecycle } = await holdLifecycle(storePath, scope.sessionId);
  const enqueue = sessionController.runSessionMutation;
  const removalQueued = createDeferredCore();
  const mutationQueued = createDeferredCore();
  let queuedMutations = 0;
  const queue = vi.spyOn(sessionController, "runSessionMutation").mockImplementation((params) => {
    const pending = enqueue(params);
    if ("target" in params && params.target.storeScope === storePath) {
      queuedMutations += 1;
      if (queuedMutations === 1) {
        removalQueued.resolve();
      } else if (queuedMutations === 2) {
        mutationQueued.resolve();
      }
    }
    return pending;
  });
  const sourceEntry = await readSessionEntryReadOnlyInWorker(scope);
  const respond = vi.fn<RespondFn>();
  const params = { sessionKey: scope.sessionKey, identityId: "member" };
  const removal = (async () => {
    await expectDefined(
      sessionSharingHandlers["session.members.remove"],
      "remove handler",
    )({
      req: { type: "req", id: "remove-fork-member", method: "session.members.remove", params },
      params,
      respond,
      client: { connect: { role: "operator", scopes: ["operator.admin"] } } as GatewayClient,
      context: {
        ...requestContext,
        // The public removal publishes inside its fence, before the waiting fork can enter.
        broadcast: vi.fn(() => expect(loadSessionEntryReadOnly(scope)).toEqual(sourceEntry)),
      },
      isWebchatConnect: () => false,
    });
  })().then(
    () => undefined,
    (error: unknown) => error,
  );
  let mutation: ReturnType<typeof invokeMessageCut> | undefined;
  try {
    await awaitGateBeforeSettlement(
      removalQueued.promise,
      removal,
      "Member removal settled before joining its session controller",
    );
    mutation = invoke();
    await awaitGateBeforeSettlement(
      mutationQueued.promise,
      mutation.error,
      "Message cut settled before joining its session controller",
    );
  } finally {
    queue.mockRestore();
    release();
    await heldLifecycle;
    await removal;
    await mutation?.error;
  }
  expect(await removal).toBeUndefined();
  expectCutReply(respond, { ok: true, ...params });
  return expectDefined(mutation, "queued fork");
}

it.each(
  mutationMethods.flatMap((method) =>
    [false, true].map((lockWhileQueued) => ({ method, lockWhileQueued })),
  ),
)(
  "rejects local $method on model-locked history (lockWhileQueued=$lockWhileQueued)",
  async ({ method, lockWhileQueued }) => {
    await withStorage(async () => {
      // Native fault injection needs its handle before asynchronous writers start.
      openOpenClawAgentDatabase({ agentId: "main" });
      const scope = await seedMessageCutSource();
      let before: Awaited<ReturnType<typeof readMutationStorage>> | undefined;
      const lockSource = async () => {
        const patch = { agentHarnessId: "external-harness", modelSelectionLocked: true };
        if (lockWhileQueued) {
          // Fault injection bypasses the queue whose waiting mutation is under test.
          runOpenClawAgentWriteTransaction(
            (database) => {
              writeSessionEntry(database, scope.sessionKey, {
                ...expectDefined(loadSessionEntryReadOnly(scope), "source before harness lock"),
                ...patch,
              });
            },
            toDatabaseOptions(resolveSqliteScope(scope)),
          );
        } else {
          expectDefined(
            await patchSessionEntryCore(scope, () => patch),
            "source before harness lock",
          );
        }
        before = await readMutationStorage(scope);
      };
      if (!lockWhileQueued) {
        await lockSource();
      }
      const mutation = lockWhileQueued
        ? await revokeDuringWriterWait(scope, () => invokeMessageCut(method, scope), lockSource)
        : invokeMessageCut(method, scope);
      expect(await mutation.error).toBeUndefined();
      expectFailure(mutation.respond, {
        code: ErrorCodes.INVALID_REQUEST,
        message: "Session history changes are unavailable while model selection is locked.",
      });
      expect(await readMutationStorage(scope)).toEqual(before);
    });
  },
);

it.each([
  { kind: "incognito", incognito: true, visibility: "draft" },
  { kind: "ordinary", incognito: false, visibility: "draft" },
  { kind: "repository", incognito: false },
  { kind: "repository-changed", incognito: false },
  { kind: "local-project", incognito: false, visibility: "shared" },
])(
  "preserves source and child storage ownership during $kind fork preparation",
  async ({ kind, incognito, visibility }) => {
    await withStorage(async (testState) => {
      if (kind === "repository-changed") {
        openOpenClawAgentDatabase({ agentId: "main" });
      }
      const sourceScope = await seedMessageCutSource(incognito);
      if (visibility === "draft" || visibility === "shared") {
        await upsertSessionEntryCore(sourceScope, { visibility });
      }
      const { sessionKey } = sourceScope;
      const repositories = getSessionRepositoryWorkspaceStore();
      const repository = kind.startsWith("repository")
        ? await repositories.create({
            agentId: "main",
            sessionKey,
            url: "https://github.com/openclaw/fixture.git",
            runSetupScript: false,
            assertCurrent: () => {},
          })
        : undefined;
      if (repository) {
        await upsertSessionEntryCore(sourceScope, {
          repositoryWorkspaceId: repository.workspaceId,
        });
      }
      const projectRoot = `${testState.stateDir}/qa-writer`;
      const projectEntry = {
        projectId: "qa-writer",
        spawnedCwd: projectRoot,
        sessionRoot: projectRoot,
      };
      if (kind === "local-project") {
        fs.mkdirSync(projectRoot);
        await upsertSessionEntryCore(sourceScope, projectEntry);
      }
      const sourceEntry = expectDefined(
        await readSessionEntryReadOnlyInWorker(sourceScope),
        "fork source",
      );
      const sourceEvents = await loadTranscriptEvents(sourceScope);
      const grants: string[] = [];
      const sourceReads: string[] = [];
      const agentPath = resolveOpenClawAgentSqlitePath({ agentId: sourceScope.agentId });
      const admission = repository
        ? probe.admission(workerAdmission, (request, grant, callback) => {
            const facts = request.facts;
            if (
              (request.stage !== "transaction" && request.stage !== "commit") ||
              !isRecord(facts) ||
              !isRecord(facts.identity) ||
              facts.identity.nativeLocation !== agentPath
            ) {
              callback(request, grant);
              return;
            }
            // Repository S grants retain separate authority; observe only this agent writer.
            const sql = observeHostDataSql();
            try {
              grants.push(request.stage);
              callback(request, grant);
            } finally {
              sourceReads.push(
                ...sql.queries.filter((query) =>
                  /^\s*(?:select|with)\b[\s\S]*\bsession_nodes\b/i.test(query),
                ),
              );
              sql.restore();
            }
          })
        : undefined;
      let racedStorage: Awaited<ReturnType<typeof readMutationStorage>> | undefined;
      let repositoryForkId: string | undefined;
      const prepareRepository = repositoryCheckpoints.forkSessionRepositoryWorkspace;
      const preparation =
        kind === "repository-changed"
          ? vi
              .spyOn(repositoryCheckpoints, "forkSessionRepositoryWorkspace")
              .mockImplementation(async (...args) => {
                const target = await prepareRepository(...args);
                repositoryForkId = target.workspaceId;
                await runOpenClawAgentWriteAdmission({ agentId: sourceScope.agentId }, () =>
                  runOpenClawAgentWriteTransaction(
                    (database) =>
                      writeSessionEntry(database, sessionKey, {
                        ...sourceEntry,
                        repositoryWorkspaceId: undefined,
                      }),
                    { agentId: sourceScope.agentId },
                  ),
                );
                racedStorage = await readMutationStorage(sourceScope);
                expect([
                  racedStorage.source?.repositoryWorkspaceId,
                  racedStorage.source?.sessionId,
                  racedStorage.source?.lifecycleRevision,
                ]).toEqual([undefined, sourceScope.sessionId, sourceEntry.lifecycleRevision]);
                return target;
              })
          : undefined;
      let mutation: ReturnType<typeof invokeMessageCut>;
      try {
        mutation = invokeMessageCut("sessions.fork", sourceScope);
        expect(await mutation.error).toBeUndefined();
      } finally {
        admission?.mockRestore();
        preparation?.mockRestore();
      }
      const { respond } = mutation;
      if (kind === "repository-changed") {
        expectFailure(respond, { code: ErrorCodes.UNAVAILABLE });
        expect(await readMutationStorage(sourceScope)).toEqual(racedStorage);
        await expect(
          repositories.get(expectDefined(repositoryForkId, "prepared repository fork")),
        ).resolves.toBeUndefined();
        return;
      }
      if (repository) {
        expect(grants).toContain("transaction");
        expect(grants).toContain("commit");
        expect(sourceReads).toEqual([]);
      }

      expectCutReply(respond, { sessionKey: expect.any(String), editorText: "What did I say?" });
      const result = expectDefined(
        respond.mock.calls[0]?.[1] as SessionsForkResult | undefined,
        "fork response",
      );
      const childScope = { agentId: "main", sessionKey: result.sessionKey };
      // Resolve exactly the returned key, without supplying the source's volatile store path.
      const child = expectDefined(
        await readSessionEntryReadOnlyInWorker(childScope),
        "fork child at returned key",
      );
      expect(isIncognitoSessionKey(result.sessionKey)).toBe(incognito);
      expect(child.incognito === true).toBe(incognito);
      expect(child.sessionId).not.toBe(sourceScope.sessionId);
      expect(child.parentSessionKey).toBe(sessionKey);
      expect(child.visibility ?? "shared").toBe(visibility === "draft" ? "draft" : "shared");
      if (kind === "local-project") {
        expect(child).toMatchObject(projectEntry);
      }
      if (repository) {
        expect(child.repositoryWorkspaceId).toBeDefined();
        expect(child.repositoryWorkspaceId).not.toBe(repository.workspaceId);
        expect(await repositories.find(childScope)).toMatchObject({
          workspaceId: child.repositoryWorkspaceId,
          url: repository.url,
          sessionKey: childScope.sessionKey,
        });
        expect(await repositories.get(repository.workspaceId)).toEqual(repository);
        expect([child.sessionRoot, child.worktree, child.spawnedCwd]).toEqual([
          undefined,
          undefined,
          undefined,
        ]);
      }
      const childTranscriptScope = { ...childScope, sessionId: child.sessionId };
      const childEvents = await loadTranscriptEvents(childTranscriptScope);
      expect(childEvents).toEqual([
        expect.objectContaining({ type: "session", id: child.sessionId }),
        ...sourceEvents.slice(1, 3),
      ]);
      expect(await readSessionEntryReadOnlyInWorker(sourceScope)).toEqual(sourceEntry);
      await expect(loadTranscriptEvents(sourceScope)).resolves.toEqual(sourceEvents);

      // Omitting the incognito key deliberately inspects the durable agent store.
      const durableRows = await readSessionEntrySummariesInWorker({
        agentId: "main",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      });
      expect(durableRows.some((row) => row.sessionKey === result.sessionKey)).toBe(!incognito);
      await expect(
        loadTranscriptEvents({ agentId: "main", sessionId: child.sessionId }),
      ).resolves.toEqual(incognito ? [] : childEvents);

      const databasePath = incognito
        ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" })
        : resolveOpenClawAgentSqlitePath({ agentId: "main" });
      expect(fs.existsSync(databasePath)).toBe(!incognito);
      if (incognito) {
        memorySessionActorOwners.closeDatabase({ agentId: "main", path: databasePath });
      } else {
        // Worker-only stores can close without a cached main-thread handle.
        await closeOpenClawAgentDatabaseByPathAsync(databasePath);
      }
      expect(await readSessionEntryReadOnlyInWorker(childScope)).toEqual(
        incognito ? undefined : child,
      );
      await expect(loadTranscriptEvents(childTranscriptScope)).resolves.toEqual(
        incognito ? [] : childEvents,
      );
    });
  },
);
it.each(
  mutationMethods.flatMap((method) =>
    (["sessionMutationCommitGuard", "sessionMutationAuthorization"] as const).map((guardKind) => ({
      method,
      guardKind,
    })),
  ),
)(
  "revalidates $method $guardKind authority at the transaction boundary",
  async ({ method, guardKind }) => {
    await withStorage(async () => {
      const scope = await seedMessageCutSource();
      await waitForSessionTranscriptIndexReconcile({ agentId: scope.agentId });
      const before = await readMutationStorage(scope);
      const denied = new SessionMutationAuthorizationChangedError(
        errorShape(ErrorCodes.FORBIDDEN, "admitted mutation authority was revoked"),
      );
      let current = true;
      let workerCommitGrant = false;
      let rejectedAtWriteEdge = false;
      const assertCurrent = () => {
        if (!current) {
          rejectedAtWriteEdge ||= workerCommitGrant;
          throw denied;
        }
      };
      const guards =
        guardKind === "sessionMutationCommitGuard"
          ? { sessionMutationCommitGuard: assertCurrent }
          : { sessionMutationAuthorization: { assertCurrent, assertTargetCurrent: vi.fn() } };
      probe.admission(workerAdmission, (request, grant, callback) => {
        workerCommitGrant = request.stage === "commit";
        if (workerCommitGrant) {
          current = false;
        }
        try {
          callback(request, grant);
        } finally {
          workerCommitGrant = false;
        }
      });
      const mutation = invokeMessageCut(method, scope, guards);
      await mutation.error;

      expect.soft(await readMutationStorage(scope)).toEqual(before);
      expect.soft(rejectedAtWriteEdge).toBe(true);
      expect(await mutation.error).toBe(denied);
      expect(mutation.respond).not.toHaveBeenCalledWith(true, expect.anything(), undefined);
    }, true);
  },
);

it.each([false, true].flatMap((incognito) => [false, true].map((late) => ({ incognito, late }))))(
  "refuses new Draft copies when disabled (memory=$incognito, late=$late)",
  async ({ incognito, late }) => {
    await withStorage(async () => {
      const scope = await seedMessageCutSource(incognito);
      await upsertSessionEntryCore(scope, { visibility: "draft" });
      const before = await readMutationStorage(scope);
      let enabled = late;
      const requestContext = context();
      requestContext.getCommittedRuntimeConfig = () =>
        enabled ? cfg : { ...cfg, session: { sharing: { drafts: false } } };
      const run = async () => {
        const mutation = invokeMessageCut("sessions.fork", scope, { context: requestContext });
        const error = await mutation.error;
        expect(enabled).toBe(false);
        expect(error).toMatchObject({
          error: {
            code: ErrorCodes.INVALID_REQUEST,
            message: expect.stringContaining("Continue in this conversation"),
            details: { code: "SESSION_VISIBILITY_DISABLED", visibility: "draft" },
          },
        });
        expect(mutation.respond).not.toHaveBeenCalledWith(true, expect.anything(), undefined);
        expect(await readMutationStorage(scope)).toEqual(before);
      };
      if (late && incognito) {
        const createStorage = memoryStorage.createSessionActorMemoryStorage;
        vi.spyOn(memoryStorage, "createSessionActorMemoryStorage").mockImplementation((options) => {
          const storage = createStorage(options);
          const mutate = storage.mutate.bind(storage);
          storage.mutate = (command, guard, observer) =>
            mutate(command, guard, {
              ...observer,
              async beforeCommit(receipt) {
                await observer?.beforeCommit?.(receipt);
                if (command.type === "session.messageCut") {
                  enabled = false;
                }
              },
            });
          return storage;
        });
        await run();
      } else {
        if (late) {
          probe.admission(workerAdmission, (request, grant, callback) => {
            if (
              request.stage === "commit" &&
              isRecord(request.facts) &&
              isRecord(request.facts.publication) &&
              request.facts.publication.kind === "session-entry-patch-committed"
            ) {
              enabled = false;
            }
            callback(request, grant);
          });
        }
        await run();
      }
    });
  },
);

it.each(["SQLite writer fault injection", "public lifecycle predecessor"] as const)(
  "sessions.fork revalidates source participation after %s",
  async (revocation) => {
    await withStorage(async () => {
      // Both variants use native fixture reads; admit their handle before asynchronous writers.
      openOpenClawAgentDatabase({ agentId: "main" });
      const scope = await seedMemberSource();
      const { authorization, options, request } = await authorizeMemberFork(scope);
      const invoke = () => {
        expect(() => authorization.assertCurrent()).not.toThrow();
        return invokeMessageCut("sessions.fork", scope, options);
      };
      using _ = { [Symbol.dispose]: () => authorization.release?.() };
      const before = await readMutationStorage(scope);
      const mutation =
        revocation === "public lifecycle predecessor"
          ? await revokeWithPublicLifecyclePredecessor(scope, options.context, invoke)
          : await revokeDuringWriterWait(scope, invoke, () => {
              expect(
                removeSessionMember(scope, "member", undefined, scope.sessionId),
              ).not.toBeNull();
              expect(loadSessionEntryReadOnly(scope)).toEqual(before.source);
            });

      expect((await resolveSessionMutationAuthorizationAsync(request)).error).toMatchObject({
        details: { code: "SESSION_PARTICIPATION_REQUIRED" },
      });
      expect.soft(await readMutationStorage(scope)).toEqual(before);
      expect(await mutation.error).toBeInstanceOf(SessionMutationAuthorizationChangedError);
      expect(await mutation.error).toMatchObject({
        error: {
          details: {
            code:
              revocation === "public lifecycle predecessor"
                ? "SESSION_MUTATION_AUTHORIZATION_CHANGED"
                : "SESSION_PARTICIPATION_REQUIRED",
          },
        },
      });
      expect(mutation.respond).not.toHaveBeenCalledWith(true, expect.anything(), undefined);
    }, true);
  },
);

// Every message-cut action restores before its commit guard; fork also crosses member authority.
it("sessions.fork retains member authority while restoring cold source history", async () => {
  await withStorage(async () => {
    const coldDatabase = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const scope = await seedMemberSource();
    const options = toDatabaseOptions(resolveSqliteScope(scope));
    await waitForSessionTranscriptIndexReconcile(options);
    // Age the idle source past the cold-storage threshold through its entry owner.
    await runOpenClawAgentWriteAdmission(options, () =>
      runOpenClawAgentWriteTransaction((database) => {
        const source = expectDefined(loadSessionEntryReadOnly(scope), "source entry");
        writeSessionEntry(database, scope.sessionKey, { ...source, updatedAt: 1 });
        database.db
          .prepare(
            "UPDATE session_nodes SET last_activity_at = NULL, last_interaction_at = NULL WHERE session_key = ?",
          )
          .run(scope.sessionKey);
        database.db
          .prepare(
            "UPDATE session_windows SET updated_at = 1, transcript_updated_at = 1 WHERE session_id = ?",
          )
          .run(scope.sessionId);
      }, options),
    );
    expect(
      await runSessionColdStorageMaintenance({
        config: { ...cfg, session: { maintenance: { coldStorage: { enabled: true } } } },
      }),
    ).toEqual({ archivedTranscripts: 1, externalizedTranscripts: 0 });
    expect(readSessionColdTranscript(coldDatabase, scope.sessionId)).toBeDefined();
    const { authorization, options: mutationOptions } = await authorizeMemberFork(scope);

    using _ = { [Symbol.dispose]: () => authorization.release?.() };
    const mutation = invokeMessageCut("sessions.fork", scope, mutationOptions);

    expect(await mutation.error).toBeUndefined();
    expectCutReply(mutation.respond, expect.any(Object));
    expect(readSessionColdTranscript(coldDatabase, scope.sessionId)).toBeUndefined();
  });
});

function adoptUpstreamSource(scope: SourceScope, threadId = "late-upstream-thread"): boolean {
  return upsertSessionUpstreamLink(
    {
      sessionKey: scope.sessionKey,
      agentId: scope.agentId,
      catalogId: "fixture",
      hostId: "gateway:local",
      threadId,
      upstreamKind: "codex-app-server",
      upstreamRef: { threadId },
      marker: null,
    },
    { now: 1 },
  );
}

function withSource(run: (scope: SourceScope) => Promise<void>, incognito = false) {
  return withStorage(async () => {
    const scope = await seedMessageCutSource(incognito);
    const before = await readMutationStorage(scope);
    await run(scope);
    expect(await readMutationStorage(scope)).toEqual(before);
  });
}

it.each(
  (["sessions.fork", "sessions.rewind"] as const).flatMap((method) =>
    (["transaction", "commit"] as const).map((boundary) => ({ method, boundary })),
  ),
)(
  "refuses $method when an upstream link appears at the $boundary boundary",
  async ({ method, boundary }) => {
    await withSource(async (scope) => {
      openOpenClawStateDatabase();
      let linked = false;
      probe.admission(workerAdmission, (request, grant, callback) => {
        if (
          !linked &&
          request.stage === boundary &&
          isRecord(request.facts) &&
          (boundary === "transaction"
            ? request.facts.publication === undefined
            : isRecord(request.facts.publication) &&
              request.facts.publication.kind === "session-entry-patch-committed")
        ) {
          linked = adoptUpstreamSource(scope);
        }
        callback(request, grant);
      });
      const mutation = invokeMessageCut(method, scope);
      await mutation.error;

      expect(linked).toBe(true);
      expect(mutation.respond).not.toHaveBeenCalledWith(true, expect.anything(), undefined);
    });
  },
);

it.each(["preparation", "current guard"] as const)(
  "refuses a local cut when upstream %s is unavailable",
  async (phase) => {
    await withSource(async (scope) => {
      const prepare = upstreamReads.prepareSessionUpstreamPresence;
      vi.spyOn(upstreamReads, "prepareSessionUpstreamPresence").mockImplementationOnce(
        async (...args) => {
          if (phase === "preparation") {
            throw new Error("fixture upstream read unavailable");
          }
          const prepared = await prepare(...args);
          return {
            ...prepared,
            current() {
              throw new Error("fixture upstream facts unavailable");
            },
          };
        },
      );
      const mutation = invokeMessageCut("sessions.rewind", scope);
      expect(await mutation.error).toBeUndefined();
      expectFailure(mutation.respond, { code: ErrorCodes.UNAVAILABLE });
    });
  },
);

it("refuses incognito native context effects after upstream revocation during preparation", async () => {
  await withSource(async (scope) => {
    openOpenClawStateDatabase();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let linked = false;
    const effect = vi.fn();
    const rollback = vi.fn();
    installHarness(
      {
        label: "Native source fixture",
        supports: () => ({ supported: true }),
        withSessionContextReset: async (params, run) => {
          entered.resolve();
          await release.promise;
          params.assertCurrent();
          effect();
          return run({ commit: effect, rollback });
        },
      },
      true,
      "native-upstream-fixture",
    );
    const mutation = invokeMessageCut("sessions.rewind", scope);
    try {
      await awaitGateBeforeSettlement(entered.promise, mutation.error, "native reset preparation");
      linked = adoptUpstreamSource(scope);
    } finally {
      release.resolve();
    }
    expect(await mutation.error).toBeUndefined();
    expect(linked).toBe(true);
    expect(
      await upstreamReads.prepareSessionUpstreamLink(
        upstreamReads.captureSessionUpstreamLinkReadSource(),
        scope.sessionKey,
        scope.agentId,
      ),
    ).toMatchObject({ threadId: "late-upstream-thread" });
    expect(effect).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
    expectFailure(mutation.respond, {
      message: expect.stringContaining("external agent harness"),
    });
  }, true);
});
it("refuses a shared-state owner retired while rewind waits for the lifecycle lock", async () => {
  await withSource(async (scope) => {
    const { release, settled: holding } = await holdLifecycle(
      resolveSessionStorePathCore(undefined, { agentId: scope.agentId }),
      scope.sessionId,
    );
    const mutation = invokeMessageCut("sessions.rewind", scope);
    try {
      await closeOpenClawStateDatabaseAsync();
    } finally {
      release();
      await holding;
    }
    expect(await mutation.error).toMatchObject({
      message: expect.stringMatching(/state database read admission (?:changed|is closed)/),
    });
    expect(mutation.respond).not.toHaveBeenCalledWith(true, expect.anything(), undefined);
  });
});
