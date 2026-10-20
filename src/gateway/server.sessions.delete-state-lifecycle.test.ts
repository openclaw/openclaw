import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, test, vi } from "vitest";
import type { SessionsCompanionStateResult } from "../../packages/gateway-protocol/src/index.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { AgentHarnessSessionCleanupError } from "../agents/harness/errors.js";
import { listRegisteredAgentHarnesses, registerAgentHarness } from "../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../agents/harness/registry.test-support.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import * as sessionArchiveStore from "../config/sessions/session-accessor.sqlite-archive-store.js";
import * as sessionArchive from "../config/sessions/session-accessor.sqlite-archive.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import {
  emitSessionIdentityMutation,
  onSessionIdentityMutation,
  type SessionIdentityMutation,
} from "../sessions/session-lifecycle-events.js";
import * as agentDb from "../state/openclaw-agent-db.js";
import * as stateDb from "../state/openclaw-state-db.js";
import * as repositoryWorkspaces from "../state/session-repository-workspaces.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import { loadGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.js";
import { defaultSessionCompanionContextReader } from "./session-companion-context.js";
import {
  companionRuntimeConfig,
  observeCompanionCleanup,
  publishCompanionRuntime,
} from "./session-companion-runtime.test-support.js";
import { createSessionCompanion, type SessionCompanionService } from "./session-companion.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
const runLoop = vi.hoisted(() =>
  vi.fn<
    (typeof import("../agents/embedded-agent-runner/run-loop.js"))["runPreparedEmbeddedLoop"]
  >(),
);
// mock-isolation: Retain native companion/session preparation; stop before provider I/O.
vi.mock("../agents/embedded-agent-runner/run-loop.js", () => ({
  runPreparedEmbeddedLoop: runLoop,
}));

function afterSessionStateMaterialization(after: () => void | Promise<void>) {
  const materialize = sessionArchive.materializeSessionStateDeletePlans;
  // Earlier files can load the owner in this non-isolated shard. Observe its
  // real export instead of replacing a module after that owner has captured it.
  vi.spyOn(sessionArchive, "materializeSessionStateDeletePlans").mockImplementation(
    async (...args) => {
      const result = await materialize(...args);
      await after();
      return result;
    },
  );
}

const {
  createSessionStoreDir,
  createConfiguredGlobalAgentSessionStore,
  resetConfiguredGlobalAgentSessionStore,
} = setupGatewaySessionsHandlerTestHarness();
const companions = new Set<SessionCompanionService>();
const cleanups: Array<() => void | Promise<void>> = [];

async function createStoredSession(
  sessionId = "lifecycle-session",
  entry: Parameters<typeof sessionStoreEntry>[1] = {},
  sessionKey = "agent:main:lifecycle-session",
) {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId, entry) } });
  return { sessionKey, sessionId, storePath };
}

async function deleteSession(sessionKey: string, options?: Parameters<typeof directSessionReq>[2]) {
  const response = await directSessionReq("sessions.delete", { key: sessionKey }, options);
  expect(response).toMatchObject({ ok: true, payload: { deleted: true } });
}

afterEach(async () => {
  for (const companion of companions) {
    companion.dispose();
  }
  companions.clear();
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  await disposeSessionReadContexts();
  vi.restoreAllMocks();
  await agentDb.closeOpenClawAgentDatabasesAsync();
  agentDb.closeOpenClawAgentDatabasesForTest();
  await stateDb.closeOpenClawStateDatabaseAsync();
  stateDb.closeOpenClawStateDatabaseForTest();
});

test.each(["sessions.reset", "sessions.delete"] as const)(
  "%s preserves the session generation until mandatory native cleanup succeeds",
  async (method) => {
    const { storePath, sessionKey, sessionId } = await createStoredSession(
      "mandatory-cleanup-session",
      { lifecycleRevision: "before-cleanup" },
      "agent:main:dashboard:mandatory-cleanup",
    );
    const before = loadSessionEntry({ sessionKey, storePath });
    const registeredHarnesses = listRegisteredAgentHarnesses();
    cleanups.push(() => restoreRegisteredAgentHarnesses(registeredHarnesses));
    const cleanupFailure = new AgentHarnessSessionCleanupError("Native session is still active");
    let cleanupBlocked = true;
    registerAgentHarness({
      id: "mandatory-cleanup-fixture",
      label: "Mandatory cleanup fixture",
      supports: () => ({ supported: false }),
      runAttempt: async () => {
        throw new Error("not used");
      },
      reset: async (input) => {
        expect(input.sessionId).toBe(sessionId);
        if (cleanupBlocked) {
          throw cleanupFailure;
        }
      },
    });
    await expect(directSessionReq(method, { key: sessionKey })).rejects.toThrow(cleanupFailure);
    expect(loadSessionEntry({ sessionKey, storePath })).toEqual(before);

    cleanupBlocked = false;
    const retried = await directSessionReq(method, { key: sessionKey });
    expect(retried.ok, JSON.stringify(retried.error)).toBe(true);
    const after = loadSessionEntry({ sessionKey, storePath });
    if (method === "sessions.delete") {
      expect(retried.payload).toMatchObject({ deleted: true });
      expect(after).toBeUndefined();
    } else {
      expect(after?.lifecycleRevision).toEqual(expect.any(String));
      expect(after?.lifecycleRevision).not.toBe(before?.lifecycleRevision);
    }
  },
);

test("repository ownership survives reset and archive, then permanent deletion releases it", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:repository-lifecycle";
  const repositories = repositoryWorkspaces.getSessionRepositoryWorkspaceStore();
  const repository = await repositories.create({
    agentId: "main",
    sessionKey,
    url: "https://github.com/openclaw/fixture.git",
    runSetupScript: false,
    assertCurrent: () => {},
  });
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry("repository-lifecycle-session", {
        repositoryWorkspaceId: repository.workspaceId,
      }),
    },
  });
  const artifactRoot = repositories.artifactPath(repository.workspaceId);
  await fs.mkdir(artifactRoot, { recursive: true });
  await fs.writeFile(path.join(artifactRoot, "retained-checkpoint"), "accepted checkpoint");

  for (const [method, params] of [
    ["sessions.reset", { key: sessionKey }],
    ["sessions.patch", { key: sessionKey, archived: true }],
    ["sessions.patch", { key: sessionKey, archived: false }],
  ] as const) {
    const result = await directSessionReq(
      method,
      method === "sessions.patch"
        ? { ...params, expectedSessionId: loadSessionEntry({ sessionKey, storePath })!.sessionId }
        : params,
    );
    expect(result.ok, JSON.stringify(result.error)).toBe(true);
    const entry = loadSessionEntry({ sessionKey, storePath });
    expect(entry?.repositoryWorkspaceId).toBe(repository.workspaceId);
    expect(entry?.worktree).toBeUndefined();
    expect(entry?.spawnedCwd).toBeUndefined();
    expect(await repositories.get(repository.workspaceId)).toEqual(repository);
  }
  const denied = await directSessionReq("sessions.delete", {
    key: sessionKey,
    expectedSessionId: "replaced-session",
  });
  expect(denied.ok).toBe(false);
  expect(await repositories.get(repository.workspaceId)).toEqual(repository);
  expect(await fs.readFile(path.join(artifactRoot, "retained-checkpoint"), "utf8")).toBe(
    "accepted checkpoint",
  );
  const deleted = await directSessionReq("sessions.delete", { key: sessionKey });
  expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
  expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  expect(await repositories.get(repository.workspaceId)).toBeUndefined();
  await expect(fs.stat(artifactRoot)).rejects.toMatchObject({ code: "ENOENT" });
});

test.each(["owner grant", "retained placeholder", "folded sibling", "malformed row"] as const)(
  "repository cleanup preserves full logical absence checks for %s",
  async (boundary) => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:matrix:channel:!Mixed:example.org";
    const repositories = repositoryWorkspaces.getSessionRepositoryWorkspaceStore();
    const repository = await repositories.create({
      agentId: "main",
      sessionKey,
      url: "https://github.com/openclaw/fixture.git",
      assertCurrent: () => {},
    });
    const original = sessionStoreEntry("repository-cleanup-original", {
      repositoryWorkspaceId: repository.workspaceId,
    });
    await writeSessionStore({ entries: { [sessionKey]: original } });
    const artifactRoot = repositories.artifactPath(repository.workspaceId);
    await fs.mkdir(artifactRoot, { recursive: true });
    const artifact = path.join(artifactRoot, "retained-checkpoint");
    await fs.writeFile(artifact, "accepted checkpoint");
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
    }).path;
    if (!databasePath) {
      throw new Error("Repository cleanup fixture has no physical agent database");
    }
    const peer = new DatabaseSync(databasePath);
    cleanups.push(() => peer.close());
    const insertNode = peer.prepare(
      "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
    );
    const insertWindow = peer.prepare(
      "INSERT INTO session_windows (session_id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)",
    );
    const validateNode = peer.prepare(
      "UPDATE session_nodes SET entry_valid = ? WHERE session_key = ?",
    );
    const readRow = () =>
      peer.prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?").get(sessionKey);
    const successor = sessionStoreEntry("repository-cleanup-successor", {
      lifecycleRevision: "cleanup-successor-generation",
      repositoryWorkspaceId: repository.workspaceId,
    });
    let injected = false;
    let nativeAbsent = false;
    const ownerGrant = boundary === "owner grant";
    const placeholder = boundary === "retained placeholder";
    const inject = () => {
      expect(readRow()).toBeUndefined();
      if (ownerGrant) {
        replaceSessionEntrySync({ agentId: "main", storePath, sessionKey }, successor);
        injected = true;
        return;
      }
      const key = boundary === "folded sibling" ? sessionKey.toLowerCase() : sessionKey;
      const json = placeholder ? "{}" : "{";
      // Malformed and historical fixtures intentionally bypass the canonical writer.
      peer.exec("BEGIN IMMEDIATE");
      try {
        insertNode.run(key, successor.sessionId, json, successor.updatedAt);
        if (placeholder) {
          insertWindow.run(successor.sessionId, key, successor.updatedAt, successor.updatedAt);
        }
        validateNode.run(placeholder ? -1 : 1, key);
        peer.exec("COMMIT");
      } catch (error) {
        peer.exec("ROLLBACK");
        throw error;
      }
      injected = true;
    };
    const createStore = repositoryWorkspaces.createSessionRepositoryWorkspaceStore;
    vi.spyOn(repositoryWorkspaces, "createSessionRepositoryWorkspaceStore").mockImplementation(
      (options) => {
        const store = createStore(options);
        const remove = store.delete.bind(store);
        store.delete = async (input) => {
          if (input.workspaceId === repository.workspaceId && !ownerGrant) {
            inject();
          }
          await remove(input);
        };
        return store;
      },
    );
    probe.admission(operationAdmission, (request, grant, admit) => {
      const wrapped =
        isRecord(request.facts) && request.facts.kind === "session-entry-current"
          ? request.facts
          : undefined;
      const facts = wrapped?.domainFacts ?? request.facts;
      if (
        ownerGrant &&
        !injected &&
        request.stage === "commit" &&
        isRecord(facts) &&
        facts.workspaceId === repository.workspaceId &&
        facts.changed === true &&
        facts.workspace === undefined
      ) {
        nativeAbsent = wrapped !== undefined && wrapped.entry === undefined;
        // Commit through the owner after host guards and before releasing the native grant.
        admit(request, () => {
          inject();
          return grant();
        });
        return;
      }
      admit(request, grant);
    });
    const deletion = directSessionReq("sessions.delete", { key: sessionKey });
    if (placeholder) {
      await expect(deletion).resolves.toMatchObject({ ok: true, payload: { deleted: true } });
      expect(await repositories.get(repository.workspaceId)).toBeUndefined();
      await expect(fs.stat(artifactRoot)).rejects.toMatchObject({ code: "ENOENT" });
      expect(readRow()).toEqual({ entry_json: "{}" });
    } else {
      await expect(deletion).rejects.toBeInstanceOf(Error);
      await expect(deletion).rejects.toThrow(
        ownerGrant
          ? "Session currency changed while awaiting its native grant"
          : "invalid persisted session row",
      );
      expect(await repositories.get(repository.workspaceId)).toEqual(repository);
      expect(await fs.readFile(artifact, "utf8")).toBe("accepted checkpoint");
    }
    expect(injected).toBe(true);
    if (ownerGrant) {
      expect(JSON.parse(String(readRow()?.entry_json))).toEqual({
        ...successor,
        delivery: { kind: "none" },
      });
      expect(nativeAbsent).toBe(true);
      expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject(successor);
    }
  },
);

test("sessions.delete broadcasts the removed generation after a replacement appears", async () => {
  const { storePath, sessionKey } = await createStoredSession("generation-a");
  const broadcast = vi.fn();
  await deleteSession(sessionKey, {
    coercePayload: (payload) => {
      replaceSessionEntrySync({ sessionKey, storePath }, sessionStoreEntry("generation-b"));
      return payload;
    },
    context: {
      broadcastToConnIds: broadcast,
      getSessionEventSubscriberConnIds: () => new Set(["observer"]),
    },
  });
  expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe("generation-b");
  const removedGeneration = {
    sessionKey,
    agentId: "main",
    sessionId: "generation-a",
    reason: "delete",
    ts: expect.any(Number),
  };
  expect(broadcast.mock.calls.map(([event, payload]) => ({ event, payload }))).toEqual([
    { event: "socket.drain", payload: removedGeneration },
    { event: "sessions.changed", payload: removedGeneration },
    { event: "sessions.changed", payload: { reason: "delete", ts: expect.any(Number) } },
  ]);
});

test("sessions.delete reports an exact-entry replacement during transcript materialization", async () => {
  const lifecycleRevision = "materialization-race-revision";
  const updatedAt = 1_737_600_000_000;
  const replacement = { label: "concurrent replacement", lifecycleRevision, updatedAt };
  const { storePath, sessionKey, sessionId } = await createStoredSession(
    "materialization-race-run",
    { lifecycleRevision, updatedAt },
    "agent:main:cron:materialization-race",
  );
  const events = [{ type: "session" as const, id: sessionId, content: "original transcript" }];
  await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, events);
  afterSessionStateMaterialization(() => {
    replaceSessionEntrySync({ sessionKey, storePath }, sessionStoreEntry(sessionId, replacement));
  });

  const changed = await directSessionReq("sessions.delete", {
    key: sessionKey,
    expectedLifecycleRevision: lifecycleRevision,
    expectedSessionId: sessionId,
  });
  expect(changed).toMatchObject({
    ok: false,
    error: {
      message: `Session ${sessionKey} changed before deletion. Retry.`,
      details: { reason: "session-changed" },
    },
  });

  expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
    ...replacement,
    sessionId,
  });
  await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toEqual(events);
});

test.each(["authorization", "placement"] as const)(
  "sessions.delete rechecks %s after transcript materialization before committing",
  async (change) => {
    const { storePath, sessionKey, sessionId } = await createStoredSession();
    const events = [{ type: "session" as const, id: sessionId, content: "preserve transcript" }];
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, events);
    const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
    let authorized = true;
    afterSessionStateMaterialization(async () => {
      if (change === "authorization") {
        authorized = false;
      } else {
        await placementStore.startDispatch({ sessionId, sessionKey, agentId: "main" });
      }
    });
    await expect(
      directSessionReq(
        "sessions.delete",
        { key: sessionKey },
        {
          context: { workerSessionPlacementService: placementStore },
          sessionMutationAuthorization: {
            assertTargetCurrent: () => {},
            assertCurrent: () => {
              if (!authorized) {
                throw new Error("session access revoked");
              }
            },
          },
        },
      ),
    ).rejects.toThrow(
      change === "authorization" ? "session access revoked" : "changed before retirement",
    );
    expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe(sessionId);
    await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toEqual(
      events,
    );
  },
);

test.each(["archive-publication", "worker-queue"] as const)(
  "sessions.delete accepts postcommit placement retirement during %s",
  async (phase) => {
    const { sessionKey, sessionId } = await createStoredSession();
    const { placementStore } = await loadGatewayWorkerEnvironmentStartupState();
    const claim = await placementStore.claimTurn({
      sessionId,
      sessionKey,
      agentId: "main",
      owner: { kind: "local" },
      claimId: "postcommit-claim",
      runId: "postcommit-run",
    });
    await placementStore.releaseTurn(claim);
    let retired = false;
    let placementService = placementStore;
    const retire = placementStore.retireSessionPlacementAsync.bind(placementStore);
    if (phase === "archive-publication") {
      const publish = sessionArchiveStore.publishSessionStateArchives;
      vi.spyOn(sessionArchiveStore, "publishSessionStateArchives").mockImplementation(
        async (...args) => {
          const result = await publish(...args);
          if (!loadSessionEntry({ sessionKey }) && !retired) {
            await placementStore.retireSessionPlacementAsync({
              sessionId,
              expectedState: "local",
              expectedGeneration: claim.placementGeneration,
            });
            retired = true;
          }
          return result;
        },
      );
    } else {
      placementService = {
        ...placementStore,
        async retireSessionPlacementAsync(...args: Parameters<typeof retire>) {
          expect(loadSessionEntry({ sessionKey })).toBeUndefined();
          expect(placementStore.get(sessionId)).toMatchObject({
            state: "local",
            generation: claim.placementGeneration,
            turnClaim: null,
          });
          // The orphan wins FIFO after deletion's host check, before its worker CAS.
          await Promise.all([
            retire(...args).then(() => {
              retired = true;
            }),
            retire(...args),
          ]);
        },
      };
    }
    await deleteSession(sessionKey, {
      context: { workerSessionPlacementService: placementService },
    });
    expect(retired).toBe(true);
    expect(placementStore.get(sessionId)).toBeUndefined();
  },
);

async function createCompanion(runModel?: () => Promise<string>) {
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const originalConfig = getRuntimeConfig();
  const cfg = companionRuntimeConfig(
    originalConfig,
    resolveAgentWorkspaceDir(originalConfig, "main"),
  );
  await publishCompanionRuntime(cfg, process.env.OPENCLAW_CONFIG_PATH);
  const settleCleanup = observeCompanionCleanup();
  cleanups.push(async () => {
    await settleCleanup();
    runLoop.mockReset();
    await resetPreparedModelRuntimeSnapshotsForTest();
  });
  runLoop.mockReset().mockImplementation(async () => ({
    meta: {
      durationMs: 1,
      finalAssistantVisibleText: await (
        runModel ?? (async () => "Synthetic answer from the selected session.")
      )(),
    },
  }));
  const service = createSessionCompanion({
    scheduler: createTestGatewayScheduler(),
    getConfig: getRuntimeConfig,
    contextReader: defaultSessionCompanionContextReader,
    sessionObserver: { getCompanionSnapshotAsync: async () => ({ agentId: "main", notes: [] }) },
  });
  companions.add(service);
  return { service, run: runLoop };
}

async function ask(
  service: SessionCompanionService,
  sessionKey: string,
  question: string,
  agentId = "main",
) {
  return service.ask({ agentId, sessionKey, question, connId: `conn-${agentId}` });
}

async function readState(service: SessionCompanionService, sessionKey: string, agentId = "main") {
  const response = await directSessionReq<SessionsCompanionStateResult>(
    "sessions.companion.state",
    { sessionKey, agentId },
    { context: { sessionCompanion: service } },
  );
  expect(response.ok, response.error?.message).toBe(true);
  return response.payload;
}

test("sessions.delete isolates Side chat for the same global key and session ID in another agent", async () => {
  const stores = await createConfiguredGlobalAgentSessionStore();
  await writeSessionStore({
    agentId: "work",
    entries: { global: sessionStoreEntry("sess-main-global") },
    storePath: stores.workStorePath,
  });
  const { service } = await createCompanion();
  cleanups.push(() => resetConfiguredGlobalAgentSessionStore(stores));
  await ask(service, "global", "Main agent question?", "main");
  await ask(service, "global", "Work agent question?", "work");
  const mainBefore = await readState(service, "global", "main");

  const deleted = await directSessionReq("sessions.delete", { key: "global", agentId: "work" });
  expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
  expect(await readState(service, "global", "main")).toEqual(mainBefore);
  expect(await readState(service, "global", "work")).toEqual({ exchanges: [] });
});

test("a delayed deletion event cannot erase Side chat for a newer generation", async () => {
  const { sessionKey } = await createStoredSession("old-generation");
  const { service } = await createCompanion();
  await ask(service, sessionKey, "Old generation question?");
  let deletion: Extract<SessionIdentityMutation, { kind: "delete" }> | undefined;
  const stop = onSessionIdentityMutation((event) => {
    if (event.kind === "delete" && event.previous.sessionId === "old-generation") {
      deletion = event;
    }
  });
  try {
    await deleteSession(sessionKey);
  } finally {
    stop();
  }
  expect(deletion).toBeDefined();
  expect(await readState(service, sessionKey)).toEqual({ exchanges: [] });
  const recreated = await directSessionReq("sessions.patch", {
    key: sessionKey,
    label: "Recreated session",
  });
  expect(recreated.ok, recreated.error?.message).toBe(true);
  expect(await readState(service, sessionKey)).toEqual({ exchanges: [] });
  await ask(service, sessionKey, "New generation question?");
  const newState = await readState(service, sessionKey);
  expect(newState?.exchanges.map((exchange) => exchange.question)).toEqual([
    "New generation question?",
  ]);

  emitSessionIdentityMutation(deletion!);
  expect(await readState(service, sessionKey)).toEqual(newState);
});

test("sessions.delete cancels a prepared Side chat ask before its late answer", async ({
  signal,
}) => {
  const { sessionKey } = await createStoredSession("active-generation");
  const pending = createDeferred<string>();
  const started = createDeferred();
  const { service, run } = await createCompanion(() => {
    started.resolve();
    return pending.promise;
  });
  const active = ask(service, sessionKey, "Can this survive deletion?");
  const failure = active.catch((error: unknown) => error);
  cleanups.push(async () => {
    pending.resolve("Late answer from the deleted session.");
    await active.catch(() => undefined);
  });
  await withinTest(
    awaitGateBeforeSettlement(started.promise, active, "Side chat settled before model start"),
    signal,
  );
  expect(run).toHaveBeenCalledOnce();
  await deleteSession(sessionKey);
  expect(run.mock.calls[0]?.[1].runParams.abortSignal?.aborted).toBe(true);
  pending.resolve("Late answer from the deleted session.");
  await expect(failure).resolves.toMatchObject({ reason: "context-unavailable" });
  expect(await readState(service, sessionKey)).toEqual({ exchanges: [] });
});
