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
import { AgentHarnessSessionCleanupError } from "../agents/harness/errors.js";
import { listRegisteredAgentHarnesses, registerAgentHarness } from "../agents/harness/registry.js";
import { restoreRegisteredAgentHarnesses } from "../agents/harness/registry.test-support.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import * as sessionArchiveStore from "../config/sessions/session-accessor.sqlite-archive-store.js";
import * as sessionArchive from "../config/sessions/session-accessor.sqlite-archive.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import {
  emitSessionIdentityMutation,
  onSessionIdentityMutation,
  type SessionIdentityMutation,
} from "../sessions/session-lifecycle-events.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import * as repositoryWorkspaces from "../state/session-repository-workspaces.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { disposeSessionReadContexts } from "./server-methods/sessions-read-cache.test-support.js";
import { loadGatewayWorkerEnvironmentStartupState } from "./server-worker-environment-startup.js";
import type { SessionCompanionAskDeps } from "./session-companion-ask.js";
import { defaultSessionCompanionContextReader } from "./session-companion-context.js";
import { createSessionCompanion, type SessionCompanionService } from "./session-companion.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  getGatewayConfigModule,
  sessionStoreEntry,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

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

afterEach(async () => {
  for (const companion of companions) {
    companion.dispose();
  }
  companions.clear();
  await disposeSessionReadContexts();
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

test.each(["sessions.reset", "sessions.delete"] as const)(
  "%s preserves the session generation until mandatory native cleanup succeeds",
  async (method) => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = "agent:main:dashboard:mandatory-cleanup";
    const sessionId = "mandatory-cleanup-session";
    await writeSessionStore({
      entries: {
        [sessionKey]: sessionStoreEntry(sessionId, { lifecycleRevision: "before-cleanup" }),
      },
    });
    const before = loadSessionEntry({ sessionKey, storePath });
    const registeredHarnesses = listRegisteredAgentHarnesses();
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
    try {
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
    } finally {
      restoreRegisteredAgentHarnesses(registeredHarnesses);
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
    await writeSessionStore({
      entries: {
        [sessionKey]: sessionStoreEntry("repository-cleanup-original", {
          repositoryWorkspaceId: repository.workspaceId,
        }),
      },
    });
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
    const successor = sessionStoreEntry("repository-cleanup-successor", {
      lifecycleRevision: "cleanup-successor-generation",
      repositoryWorkspaceId: repository.workspaceId,
    });
    let injected = false;
    let nativeAbsent = false;
    const inject = () => {
      expect(
        peer.prepare("SELECT session_key FROM session_nodes WHERE session_key = ?").get(sessionKey),
      ).toBeUndefined();
      if (boundary === "owner grant") {
        replaceSessionEntrySync({ agentId: "main", storePath, sessionKey }, successor);
        injected = true;
        return;
      }
      const key = boundary === "folded sibling" ? sessionKey.toLowerCase() : sessionKey;
      const json = boundary === "retained placeholder" ? "{}" : "{";
      // Malformed and historical fixtures intentionally bypass the canonical writer.
      peer.exec("BEGIN IMMEDIATE");
      try {
        peer
          .prepare(
            "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, ?, ?)",
          )
          .run(key, successor.sessionId, json, successor.updatedAt);
        if (boundary === "retained placeholder") {
          peer
            .prepare(
              "INSERT INTO session_windows (session_id, session_key, created_at, updated_at) VALUES (?, ?, ?, ?)",
            )
            .run(successor.sessionId, key, successor.updatedAt, successor.updatedAt);
        }
        peer
          .prepare("UPDATE session_nodes SET entry_valid = ? WHERE session_key = ?")
          .run(boundary === "retained placeholder" ? -1 : 1, key);
        peer.exec("COMMIT");
      } catch (error) {
        peer.exec("ROLLBACK");
        throw error;
      }
      injected = true;
    };
    const createStore = repositoryWorkspaces.createSessionRepositoryWorkspaceStore;
    const storeSelection = vi
      .spyOn(repositoryWorkspaces, "createSessionRepositoryWorkspaceStore")
      .mockImplementation((options) => {
        const store = createStore(options);
        const remove = store.delete.bind(store);
        store.delete = async (input) => {
          if (input.workspaceId === repository.workspaceId && boundary !== "owner grant") {
            inject();
          }
          await remove(input);
        };
        return store;
      });
    const admission = probe.admission(operationAdmission, (request, grant, admit) => {
      const wrapped =
        isRecord(request.facts) && request.facts.kind === "session-entry-current"
          ? request.facts
          : undefined;
      const facts = wrapped?.domainFacts ?? request.facts;
      if (
        boundary === "owner grant" &&
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
    try {
      const observed = await directSessionReq("sessions.delete", { key: sessionKey }).then(
        (response) => ({ response, error: undefined }),
        (error: unknown) => ({ response: undefined, error }),
      );
      expect(injected).toBe(true);
      if (boundary === "owner grant") {
        const current = peer
          .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
          .get(sessionKey);
        expect(JSON.parse(String(current?.entry_json))).toEqual({
          ...successor,
          delivery: { kind: "none" },
        });
      }
      if (boundary === "retained placeholder") {
        expect(observed.error).toBeUndefined();
        expect(observed.response).toMatchObject({ ok: true, payload: { deleted: true } });
        expect(await repositories.get(repository.workspaceId)).toBeUndefined();
        await expect(fs.stat(artifactRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect(await repositories.get(repository.workspaceId)).toEqual(repository);
        expect(await fs.readFile(artifact, "utf8")).toBe("accepted checkpoint");
        expect(observed.error).toBeInstanceOf(Error);
        expect(observed.error).toMatchObject({
          message: expect.stringContaining(
            boundary === "owner grant"
              ? "Session currency changed while awaiting its native grant"
              : "invalid persisted session row",
          ),
        });
      }
      if (boundary === "owner grant") {
        expect(nativeAbsent).toBe(true);
        expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject(successor);
      } else if (boundary === "retained placeholder") {
        expect(
          peer
            .prepare("SELECT entry_json FROM session_nodes WHERE session_key = ?")
            .get(sessionKey),
        ).toEqual({ entry_json: "{}" });
      }
    } finally {
      admission.mockRestore();
      storeSelection.mockRestore();
      peer.close();
    }
  },
);

test("sessions.delete broadcasts the removed generation after a replacement appears", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionKey = "agent:main:event-generation";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry("generation-a") } });
  const broadcast = vi.fn();
  const deleted = await directSessionReq(
    "sessions.delete",
    { key: sessionKey },
    {
      coercePayload: (payload) => {
        replaceSessionEntrySync({ sessionKey, storePath }, sessionStoreEntry("generation-b"));
        return payload;
      },
      context: {
        broadcastToConnIds: broadcast,
        getSessionEventSubscriberConnIds: () => new Set(["observer"]),
      },
    },
  );
  expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
  expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe("generation-b");
  expect(broadcast.mock.calls.map(([event, payload]) => ({ event, payload }))).toEqual([
    {
      event: "sessions.changed",
      payload: {
        sessionKey,
        agentId: "main",
        sessionId: "generation-a",
        reason: "delete",
        ts: expect.any(Number),
      },
    },
    { event: "sessions.changed", payload: { reason: "delete", ts: expect.any(Number) } },
  ]);
});

test("sessions.delete reports an exact-entry replacement during transcript materialization", async () => {
  const sessionKey = "agent:main:cron:materialization-race";
  const sessionId = "materialization-race-run";
  const lifecycleRevision = "materialization-race-revision";
  const updatedAt = 1_737_600_000_000;
  const { storePath } = await createSessionStoreDir();
  const events = [{ type: "session" as const, id: sessionId, content: "original transcript" }];
  await writeSessionStore({
    entries: {
      [sessionKey]: sessionStoreEntry(sessionId, { lifecycleRevision, updatedAt }),
    },
  });
  await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, events);
  afterSessionStateMaterialization(() => {
    replaceSessionEntrySync(
      { sessionKey, storePath },
      sessionStoreEntry(sessionId, {
        label: "concurrent replacement",
        lifecycleRevision,
        updatedAt,
      }),
    );
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
    label: "concurrent replacement",
    lifecycleRevision,
    sessionId,
    updatedAt,
  });
  await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toEqual(events);
});

test.each(["authorization", "placement"] as const)(
  "sessions.delete rechecks %s after transcript materialization before committing",
  async (change) => {
    const { storePath } = await createSessionStoreDir();
    const sessionKey = `agent:main:materialization-${change}`;
    const sessionId = `session-materialization-${change}`;
    const events = [{ type: "session" as const, id: sessionId, content: "preserve transcript" }];
    await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
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
    await createSessionStoreDir();
    const sessionKey = "agent:main:postcommit-retirement";
    const sessionId = "postcommit-retirement-session";
    await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry(sessionId) } });
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
            placementStore.retireSessionPlacement({
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
    const deleted = await directSessionReq(
      "sessions.delete",
      { key: sessionKey },
      {
        context: { workerSessionPlacementService: placementService },
      },
    );
    expect(retired).toBe(true);
    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
    expect(placementStore.get(sessionId)).toBeUndefined();
  },
);

async function createCompanion(runModel?: SessionCompanionAskDeps["run"]) {
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const run = vi.fn(runModel ?? (async () => "Synthetic answer from the selected session."));
  const service = createSessionCompanion({
    scheduler: createTestGatewayScheduler(),
    getConfig: getRuntimeConfig,
    contextReader: defaultSessionCompanionContextReader,
    sessionObserver: { getCompanionSnapshotAsync: async () => ({ agentId: "main", notes: [] }) },
    resolveUtilityModelRef: () => "openai/gpt-5.6-luna",
    run,
  });
  companions.add(service);
  return { service, run };
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

async function recreate(sessionKey: string) {
  const response = await directSessionReq<{ entry: { sessionId: string } }>("sessions.patch", {
    key: sessionKey,
    label: "Recreated session",
  });
  expect(response.ok, response.error?.message).toBe(true);
  return response.payload?.entry.sessionId;
}

test("sessions.delete isolates Side chat for the same global key and session ID in another agent", async () => {
  const stores = await createConfiguredGlobalAgentSessionStore();
  await writeSessionStore({
    agentId: "work",
    entries: { global: sessionStoreEntry("sess-main-global") },
    storePath: stores.workStorePath,
  });
  const { service } = await createCompanion();
  try {
    await ask(service, "global", "Main agent question?", "main");
    await ask(service, "global", "Work agent question?", "work");
    const mainBefore = await readState(service, "global", "main");

    const deleted = await directSessionReq("sessions.delete", { key: "global", agentId: "work" });
    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
    expect(await readState(service, "global", "main")).toEqual(mainBefore);
    expect(await readState(service, "global", "work")).toEqual({ exchanges: [] });
  } finally {
    service.dispose();
    companions.delete(service);
    await resetConfiguredGlobalAgentSessionStore(stores);
  }
});

test("a delayed deletion event cannot erase Side chat for a newer generation", async () => {
  await createSessionStoreDir();
  const sessionKey = "agent:main:companion-late-delete";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry("old-generation") } });
  const { service } = await createCompanion();
  await ask(service, sessionKey, "Old generation question?");
  let deletion: Extract<SessionIdentityMutation, { kind: "delete" }> | undefined;
  const stop = onSessionIdentityMutation((event) => {
    if (event.kind === "delete" && event.previous.sessionId === "old-generation") {
      deletion = event;
    }
  });
  try {
    const deleted = await directSessionReq("sessions.delete", { key: sessionKey });
    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
  } finally {
    stop();
  }
  expect(deletion).toBeDefined();
  expect(await readState(service, sessionKey)).toEqual({ exchanges: [] });
  await recreate(sessionKey);
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
  await createSessionStoreDir();
  const sessionKey = "agent:main:companion-active-delete";
  await writeSessionStore({ entries: { [sessionKey]: sessionStoreEntry("active-generation") } });
  const pending = createDeferred<string>();
  const started = createDeferred();
  const { service, run } = await createCompanion(() => {
    started.resolve();
    return pending.promise;
  });
  const active = ask(service, sessionKey, "Can this survive deletion?");
  const failure = active.catch((error: unknown) => error);
  try {
    await withinTest(
      awaitGateBeforeSettlement(started.promise, active, "Side chat settled before model start"),
      signal,
    );
    expect(run).toHaveBeenCalledOnce();
    const deleted = await directSessionReq("sessions.delete", { key: sessionKey });
    expect(deleted).toMatchObject({ ok: true, payload: { deleted: true } });
    expect(run.mock.calls[0]?.[0].signal.aborted).toBe(true);
    pending.resolve("Late answer from the deleted session.");
    await expect(failure).resolves.toMatchObject({ reason: "context-unavailable" });
    await active.catch(() => undefined);
    expect(await readState(service, sessionKey)).toEqual({ exchanges: [] });
  } finally {
    service.dispose();
    companions.delete(service);
    pending.resolve("Late answer from the deleted session.");
    await active.catch(() => undefined);
  }
});
