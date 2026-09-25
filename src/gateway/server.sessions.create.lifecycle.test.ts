import { readdirSync } from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { persistReplySessionEntry } from "../auto-reply/reply/session-entry-persistence.js";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteStoreScope,
  runExclusiveSqliteSessionWrite,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { peekSystemEvents } from "../infra/system-events.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { listSessionStateEventsSince } from "../sessions/session-state-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  setupPersistentSessionCreateTestHarness,
  chatSendOwner,
  requireNonEmptyString,
} from "./server.sessions.create.test-support.js";
import { listSessionGroups } from "./session-groups.js";
import { loadGatewayTestConfig } from "./test-helpers.config-runtime.js";
import { embeddedRunMock, testState, writeSessionStore } from "./test-helpers.js";
import {
  getGatewayConfigModule,
  sessionStoreEntry,
  directSessionReq,
  sessionHookMocks,
  sessionLifecycleHookMocks,
} from "./test/server-sessions.test-helpers.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const { createSessionStoreDir } = setupPersistentSessionCreateTestHarness();

// The adoption assertion below flaked once on CI (run 31609081812) with the persisted
// row missing while all 16 creates succeeded; exhaustive owner-path analysis found no
// mechanism, and the failure never reproduced locally. On mismatch, capture which SQLite
// files exist and what session_nodes actually holds so the next occurrence names the
// writer/reader split instead of printing a bare undefined.
function describeSessionStoreForensics(storePath: string): string {
  const storeDir = path.dirname(storePath);
  const files = readdirSync(storeDir).toSorted();
  const target = resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
  const database = openOpenClawAgentDatabase({ agentId: "main", path: target.path });
  const rows = database.db
    .prepare(
      "SELECT session_key, length(entry_json) AS entry_bytes, updated_at FROM session_nodes ORDER BY session_key",
    )
    .all();
  return JSON.stringify({ storeDir, files, resolvedTargetPath: target.path, rows });
}

test("sessions.create assigns and registers its requested group", async () => {
  const { storePath } = await createSessionStoreDir();
  const broadcastToConnIds = vi.fn();

  const created = await directSessionReq<{ key: string }>(
    "sessions.create",
    {
      agentId: "main",
      category: "  Client work  ",
    },
    {
      context: {
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      },
    },
  );

  expect(created.ok).toBe(true);
  const key = requireNonEmptyString(created.payload?.key, "grouped session key");
  expect(loadSessionEntry({ sessionKey: key, storePath })?.category).toBe("Client work");
  expect(listSessionGroups().map((group) => group.name)).toContain("Client work");
  expect(broadcastToConnIds).toHaveBeenCalledWith(
    "sessions.changed",
    expect.objectContaining({ reason: "groups" }),
    new Set(["conn-1"]),
    { dropIfSlow: true },
  );
});

test("sessions.create registers a category only after the session commit succeeds", async () => {
  await createSessionStoreDir();
  const category = "Deferred category";
  let validations = 0;

  const failed = await directSessionReq(
    "sessions.create",
    { agentId: "main", category, key: "agent:main:dashboard:failed-category-create" },
    {
      context: {
        validateAgentRuntimeApprovalAuthority: () => ++validations < 3,
      },
      client: {
        connect: { scopes: ["operator.write"] },
        internal: {
          agentRuntimeIdentity: {
            kind: "agentRuntime",
            agentId: "main",
            sessionKey: "agent:main:main",
          },
        },
      } as never,
    },
  );

  expect(failed.ok).toBe(false);
  expect(listSessionGroups().map((group) => group.name)).not.toContain(category);

  const broadcastToConnIds = vi.fn();
  const created = await directSessionReq(
    "sessions.create",
    { agentId: "main", category, key: "agent:main:dashboard:successful-category-create" },
    {
      context: {
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      },
    },
  );

  expect(created.ok).toBe(true);
  expect(listSessionGroups().filter((group) => group.name === category)).toHaveLength(1);
  expect(
    broadcastToConnIds.mock.calls.filter(([, payload]) => payload?.reason === "groups"),
  ).toHaveLength(1);
});

test("concurrent sessions.create requests adopt one canonical keyed session", async () => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:dashboard:concurrent-keyed-session";

  const created = await Promise.all(
    Array.from({ length: 4 }, () =>
      directSessionReq<{ key: string; sessionId: string }>("sessions.create", {
        agentId: "main",
        key,
      }),
    ),
  );

  expect(created.every((result) => result.ok)).toBe(true);
  expect(new Set(created.map((result) => result.payload?.key))).toEqual(new Set([key]));
  const sessionIds = new Set(created.map((result) => result.payload?.sessionId));
  expect(sessionIds.size).toBe(1);
  const persistedSessionId = loadSessionEntry({ sessionKey: key, storePath })?.sessionId;
  const canonicalSessionId = created[0]?.payload?.sessionId;
  expect(
    persistedSessionId,
    persistedSessionId === canonicalSessionId ? "" : describeSessionStoreForensics(storePath),
  ).toBe(canonicalSessionId);
});

test("createGatewaySession forwards its commit guard into main-session reset", async () => {
  const { storePath } = await createSessionStoreDir();
  try {
    const { createGatewaySession } = await import("./session-create-service.js");
    const key = "agent:main:main";
    const original = sessionStoreEntry("main-before-guard-close");
    testState.sessionConfig = { dmScope: "main" };
    await writeSessionStore({ entries: { main: original } });
    const commitGuard = vi.fn(() => {
      if (commitGuard.mock.calls.length > 1) {
        throw new Error("session create authority closed");
      }
    });

    await expect(
      createGatewaySession({
        cfg: getRuntimeConfig(),
        agentId: "main",
        parentSessionKey: "main",
        emitCommandHooks: true,
        resetMainWhenUnspecified: true,
        commandSource: "test",
        commitGuard,
      }),
    ).rejects.toThrow("session create authority closed");

    expect(commitGuard).toHaveBeenCalledTimes(2);
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject(
      original,
    );
  } finally {
    testState.sessionConfig = undefined;
  }
});

test("sessions.create persists draft visibility in the initial session entry", async () => {
  const { storePath } = await createSessionStoreDir();
  const created = await directSessionReq<{
    key: string;
    entry: { visibility?: string };
  }>("sessions.create", { agentId: "main", visibility: "draft" });

  expect(created.ok).toBe(true);
  expect(created.payload?.entry.visibility).toBe("draft");
  expect(peekSystemEvents("agent:main:main")).toEqual([]);
  const key = requireNonEmptyString(created.payload?.key, "created session key");
  expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.visibility).toBe(
    "draft",
  );
  const listed = await directSessionReq<{
    sessions?: Array<{ key: string; visibility?: string }>;
  }>("sessions.list", {});
  expect(listed.payload?.sessions?.find((row) => row.key === key)?.visibility).toBe("draft");
});

test("sessions.create keeps omitted visibility on the prior shared default", async () => {
  const { storePath } = await createSessionStoreDir();
  const created = await directSessionReq<{
    key: string;
    entry: { visibility?: string };
  }>("sessions.create", { agentId: "main" });

  expect(created.ok).toBe(true);
  expect(created.payload?.entry.visibility).toBeUndefined();
  const key = requireNonEmptyString(created.payload?.key, "created session key");
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.visibility,
  ).toBeUndefined();
  const listed = await directSessionReq<{
    sessions?: Array<{ key: string; visibility?: string }>;
  }>("sessions.list", {});
  expect(listed.payload?.sessions?.find((row) => row.key === key)?.visibility).toBe("shared");
});

test("sessions.create preserves keyed draft adoption idempotency", async () => {
  await createSessionStoreDir();
  const key = "agent:main:dashboard:idempotent-draft";
  const first = await directSessionReq<{
    sessionId: string;
    entry: { visibility?: string };
  }>("sessions.create", { agentId: "main", key, visibility: "draft" });

  expect(first.ok).toBe(true);
  const retried = await directSessionReq<{
    sessionId: string;
    entry: { visibility?: string };
  }>("sessions.create", { agentId: "main", key, visibility: "draft" });
  expect(retried).toMatchObject({
    ok: true,
    payload: {
      sessionId: first.payload?.sessionId,
      entry: { visibility: "draft" },
    },
  });

  testState.sessionConfig = { sharing: { drafts: false } };
  const retriedAfterPolicyChange = await directSessionReq<{
    sessionId: string;
    entry: { visibility?: string };
  }>("sessions.create", { agentId: "main", key, visibility: "draft" });
  expect(retriedAfterPolicyChange).toMatchObject({
    ok: true,
    payload: {
      sessionId: first.payload?.sessionId,
      entry: { visibility: "draft" },
    },
  });

  const mismatch = await directSessionReq("sessions.create", {
    agentId: "main",
    key,
    visibility: "shared",
  });
  expect(mismatch).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "sessions.create visibility requires a new session",
    },
  });
});

test("sessions.create rejects draft visibility when policy disables drafts", async () => {
  await createSessionStoreDir();
  testState.sessionConfig = { sharing: { drafts: false } };
  (await getGatewayConfigModule()).setRuntimeConfigSnapshot(loadGatewayTestConfig());
  const created = await directSessionReq("sessions.create", {
    agentId: "main",
    visibility: "draft",
  });

  expect(created).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "session visibility is disabled: draft",
      details: { code: "SESSION_VISIBILITY_DISABLED", visibility: "draft" },
    },
  });
});

test("sessions.create persists explicit tool overrides before the first turn", async () => {
  const { storePath } = await createSessionStoreDir();
  const parentSessionKey = "agent:main:main";
  const sessionKey = "agent:main:dashboard:create-tool-overrides";
  await writeSessionStore({
    entries: {
      [parentSessionKey]: sessionStoreEntry("tool-overrides-parent", {
        toolOverrides: { skills: { inherited: false } },
      }),
    },
  });
  const requested = {
    mcpServers: { zeta: false, alpha: true },
    mcpToolsDeny: { github: ["write", "read", "write"] },
    skills: { release: false },
    webSearch: false,
  };
  const normalized = {
    mcpServers: { alpha: true, zeta: false },
    mcpToolsDeny: { github: ["read", "write"] },
    skills: { release: false },
    webSearch: false,
  };
  const observed: Array<unknown> = [];
  const chatSend = vi.spyOn(chatSendOwner, "handleDirectExternalChatSend");
  chatSend.mockImplementation(async ({ respond }) => {
    observed.push(loadSessionEntry({ agentId: "main", sessionKey, storePath })?.toolOverrides);
    respond(true, { runId: "create-tool-overrides-run", status: "started" });
  });
  const client = { client: { connect: { scopes: ["operator.admin"] } } as never };

  try {
    const created = await directSessionReq<{
      entry?: { toolOverrides?: unknown };
      runStarted?: boolean;
    }>(
      "sessions.create",
      {
        agentId: "main",
        key: sessionKey,
        parentSessionKey,
        message: "run with the selected capabilities",
        toolOverrides: requested,
      },
      client,
    );

    expect(created).toMatchObject({
      ok: true,
      payload: { entry: { toolOverrides: normalized }, runStarted: true },
    });
    expect(observed).toEqual([normalized]);
    expect(loadSessionEntry({ agentId: "main", sessionKey, storePath })?.toolOverrides).toEqual(
      normalized,
    );

    const retried = await directSessionReq(
      "sessions.create",
      { agentId: "main", key: sessionKey, toolOverrides: requested },
      client,
    );
    expect(retried.ok).toBe(true);

    const mismatch = await directSessionReq(
      "sessions.create",
      { agentId: "main", key: sessionKey, toolOverrides: { skills: { release: true } } },
      client,
    );
    expect(mismatch).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "sessions.create toolOverrides requires a new session",
      },
    });
  } finally {
    chatSend.mockRestore();
  }
});

test("sessions.create reset-in-place clears a prior node binding for Gateway execution", async () => {
  testState.sessionConfig = { dmScope: "main" };
  await createSessionStoreDir();
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-node-parent") } });

  const nodeSession = await directSessionReq<{
    entry: { execHost?: string; execNode?: string; execCwd?: string; spawnedCwd?: string };
  }>(
    "sessions.create",
    {
      agentId: "main",
      parentSessionKey: "main",
      emitCommandHooks: true,
      execNode: "macbook",
      cwd: "/Users/peter/Projects/openclaw",
    },
    { client: { connect: { scopes: ["operator.admin"] } } as never },
  );
  expect(nodeSession.ok).toBe(true);
  expect(nodeSession.payload?.entry).toMatchObject({
    execHost: "node",
    execNode: "macbook",
    execCwd: "/Users/peter/Projects/openclaw",
  });
  expect(nodeSession.payload?.entry.spawnedCwd).toBeUndefined();

  const gatewaySession = await directSessionReq<{
    entry: { execHost?: string; execNode?: string; execCwd?: string };
  }>(
    "sessions.create",
    { agentId: "main", parentSessionKey: "main", emitCommandHooks: true },
    { client: { connect: { scopes: ["operator.write"] } } as never },
  );
  expect(gatewaySession.ok).toBe(true);
  expect(gatewaySession.payload?.entry.execHost).toBeUndefined();
  expect(gatewaySession.payload?.entry.execNode).toBeUndefined();
  expect(gatewaySession.payload?.entry.execCwd).toBeUndefined();
});

test("sessions.create reset-in-place applies Fast Mode only for admin callers", async () => {
  testState.sessionConfig = { dmScope: "main" };
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { main: sessionStoreEntry("sess-fast-reset", { fastMode: false }) },
  });
  const params = {
    agentId: "main",
    parentSessionKey: "main",
    emitCommandHooks: true,
    fastMode: true,
  };

  const denied = await directSessionReq("sessions.create", params, {
    client: { connect: { scopes: ["operator.write"] } } as never,
  });
  expect(denied).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN", message: "missing scope: operator.admin" },
  });
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: "agent:main:main", storePath }),
  ).toMatchObject({ sessionId: "sess-fast-reset", fastMode: false });

  const changed = await directSessionReq<{ entry: { fastMode?: boolean } }>(
    "sessions.create",
    params,
    { client: { connect: { scopes: ["operator.admin"] } } as never },
  );
  expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
  expect(changed.payload?.entry.fastMode).toBe(true);
  expect(
    loadSessionEntry({ agentId: "main", sessionKey: "agent:main:main", storePath }),
  ).toMatchObject({ fastMode: true });
});

test("sessions.create rechecks Fast Mode before interrupting reset work", async () => {
  testState.sessionConfig = { dmScope: "main" };
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:main";
  await writeSessionStore({
    entries: { main: sessionStoreEntry("sess-fast-race", { fastMode: false }) },
  });
  let interrupted = false;
  let releaseAdmission = () => {};
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [key, "sess-fast-race"],
    assertAllowed: () => undefined,
    onInterrupt: () => {
      interrupted = true;
      releaseAdmission();
    },
  });
  releaseAdmission = admission.release;
  let replaced = false;
  const commitGuard = () => {
    if (replaced) {
      return;
    }
    replaced = true;
    const current = loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
    if (!current) {
      throw new Error("expected current main session");
    }
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key, storePath },
      { ...current, fastMode: true },
    );
  };
  const { createGatewaySession } = await import("./session-create-service.js");

  try {
    const denied = await createGatewaySession({
      cfg: getRuntimeConfig(),
      agentId: "main",
      parentSessionKey: "main",
      emitCommandHooks: true,
      resetMainWhenUnspecified: true,
      fastMode: false,
      requestingOperatorScopes: ["operator.write"],
      allowExistingModelSelection: false,
      commandSource: "test",
      commitGuard,
    });

    expect(denied).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", message: "missing scope: operator.admin" },
    });
    expect(interrupted).toBe(false);
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
      sessionId: "sess-fast-race",
      fastMode: true,
    });
  } finally {
    admission.release();
  }
});
test("sessions.create rejects a Fast Mode change completed by draining work before reset cleanup", async () => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:main";
  const initialEntry = sessionStoreEntry("sess-fast-drain", { fastMode: false });
  await writeSessionStore({ entries: { main: initialEntry } });
  const placements = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
  const claim = placements.claimTurn({
    agentId: "main",
    sessionKey: key,
    sessionId: initialEntry.sessionId,
    owner: { kind: "local" },
    claimId: "fast-drain-claim",
    runId: "fast-drain-run",
  });
  const interrupted = createDeferredCore();
  const admission = await beginSessionWorkAdmission({
    scope: storePath,
    identities: [key, initialEntry.sessionId],
    assertAllowed: () => undefined,
    onInterrupt: () => interrupted.resolve(),
  });
  const writerEntered = createDeferredCore();
  const releaseWriter = createDeferredCore();
  const heldWriter = runExclusiveSqliteSessionWrite(
    resolveSqliteStoreScope(storePath, { agentId: "main" }),
    async () => {
      writerEntered.resolve();
      await releaseWriter.promise;
    },
    "session.transcript.batch",
  );
  await writerEntered.promise;
  const persisted = persistReplySessionEntry({
    storePath,
    sessionKey: key,
    initialEntry,
    entry: { ...initialEntry, fastMode: true },
    touchedFields: ["fastMode"],
  });
  const { performGatewaySessionReset } = await import("./session-reset-service.js");
  const reset = performGatewaySessionReset({
    key,
    reason: "new",
    commandSource: "test",
    fastModeSelection: { value: false, allowExistingChange: false },
    workerPlacementContext: { workerSessionPlacementService: placements },
  });
  try {
    await interrupted.promise;
    releaseWriter.resolve();
    await heldWriter;
    expect(await persisted).toMatchObject({ status: "current", entry: { fastMode: true } });
    placements.releaseTurn(claim);
    admission.release();
    expect(await reset).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", message: "missing scope: operator.admin" },
    });
    expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
    expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expect(placements.get(initialEntry.sessionId)).toMatchObject({ state: "local" });
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
      sessionId: initialEntry.sessionId,
      fastMode: true,
    });
  } finally {
    releaseWriter.resolve();
    await heldWriter;
    if (placements.validateTurnClaim(claim)) {
      placements.releaseTurn(claim);
    }
    admission.release();
    await reset;
  }
});

test("sessions.reset preserves the recorded permission boundary", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-permission-reset", {
        permissionMode: "guarded",
        sessionRoot: "/workspace/project",
      }),
    },
  });

  const reset = await directSessionReq<{
    entry: { permissionMode?: string; sessionRoot?: string };
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry).toMatchObject({
    permissionMode: "guarded",
    sessionRoot: "/workspace/project",
  });
});

test("sessions.create does not apply create-time visibility to an in-place reset", async () => {
  testState.sessionConfig = { dmScope: "main" };
  await createSessionStoreDir();
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-existing-main") } });

  const reset = await directSessionReq("sessions.create", {
    agentId: "main",
    parentSessionKey: "main",
    emitCommandHooks: true,
    visibility: "draft",
  });

  expect(reset).toMatchObject({
    ok: false,
    error: {
      code: "INVALID_REQUEST",
      message: "sessions.create visibility requires a new session",
    },
  });
});

test("sessions.create reset-in-place preserves the node creation stamp", async () => {
  testState.sessionConfig = { dmScope: "main" };
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("existing-main", {
        createdVia: "channel",
        createdActor: { type: "human", source: "channel", id: "telegram:42" },
        createdAt: 1234,
      }),
    },
  });

  const reset = await directSessionReq<{ entry?: Record<string, unknown> }>(
    "sessions.create",
    { agentId: "main", parentSessionKey: "main", emitCommandHooks: true },
    {
      client: {
        connect: { scopes: ["operator.write"] },
        authenticatedUserProfile: {
          profileId: ensureProfileForEmail("session-resetter@example.test").id,
          displayName: null,
          hasAvatar: false,
          updatedAt: 1,
        },
      } as never,
    },
  );

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry).toMatchObject({
    createdVia: "channel",
    createdActor: { type: "human", source: "channel", id: "telegram:42" },
    createdAt: 1234,
  });
  expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
    createdVia: "channel",
    createdActor: { type: "human", source: "channel", id: "telegram:42" },
    createdAt: 1234,
  });
});

test("sessions.create adopting an existing key does not restamp node provenance", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "agent:main:dashboard:adopted": sessionStoreEntry("existing-adopted", {
        createdVia: "spawn",
        createdActor: { type: "agent", id: "agent:main:main" },
        createdAt: 4321,
      }),
    },
  });
  const chatSend = vi.spyOn(chatSendOwner, "handleDirectExternalChatSend");
  chatSend.mockImplementation(async ({ respond }) => {
    respond(true, { runId: "adopted-run", status: "started" });
  });

  try {
    const adopted = await directSessionReq<{
      entry?: Record<string, unknown>;
      runStarted?: boolean;
    }>(
      "sessions.create",
      { key: "agent:main:dashboard:adopted", agentId: "main", message: "adopted follow-up" },
      {
        client: {
          connect: { scopes: ["operator.write"] },
          authenticatedUserProfile: {
            profileId: ensureProfileForEmail("session-adopter@example.test").id,
            displayName: null,
            hasAvatar: false,
            updatedAt: 1,
          },
        } as never,
      },
    );

    expect(adopted.ok).toBe(true);
    // Post-create work (the nested initial chat.send) still runs on adoption.
    expect(adopted.payload?.runStarted).toBe(true);
    expect(chatSend).toHaveBeenCalledTimes(1);
    expect(
      loadSessionEntry({ sessionKey: "agent:main:dashboard:adopted", storePath }),
    ).toMatchObject({
      createdVia: "spawn",
      createdActor: { type: "agent", id: "agent:main:main" },
      createdAt: 4321,
    });
    // Adoption is not a node creation: no `created` event may enter the journal.
    expect(
      listSessionStateEventsSince("agent:main:dashboard:adopted", "main", 0, 20).events.filter(
        (event) => event.kind === "created",
      ),
    ).toEqual([]);
  } finally {
    chatSend.mockRestore();
  }
});

test("sessions.create replays an identical creation once and rejects conflicting intent", async () => {
  await createSessionStoreDir();
  const { sessionCreateHandlers } = await import("./server-methods/sessions-create.js");
  let sharedContext:
    | Parameters<typeof chatSendOwner.handleDirectExternalChatSend>[0]["context"]
    | undefined;
  const chatSend = vi.spyOn(chatSendOwner, "handleDirectExternalChatSend");
  chatSend.mockImplementation(async ({ context, respond }) => {
    sharedContext ??= context;
    respond(true, { runId: "create-once", status: "started" });
  });
  const dedupe = new Map();
  const client = {
    connect: {
      role: "operator",
      scopes: ["operator.write", "operator.admin"],
      device: { id: "control-ui-device" },
    },
    authenticatedUserProfile: { profileId: ensureProfileForEmail("replay@owner.test").id },
  };
  const params = {
    agentId: "main",
    idempotencyKey: "create-once",
    message: "start this task exactly once",
    permissionMode: "full",
  };
  const request = async (nextParams = params, nextClient = client) => {
    if (!sharedContext) {
      return await directSessionReq<{ key: string }>("sessions.create", nextParams, {
        client: nextClient as never,
        context: { dedupe },
      });
    }
    let result:
      | { ok: boolean; payload?: { key: string }; error?: { code?: string; message?: string } }
      | undefined;
    await sessionCreateHandlers["sessions.create"]?.({
      req: {} as never,
      params: nextParams,
      client: nextClient as never,
      context: sharedContext,
      isWebchatConnect: () => false,
      respond: (ok, payload, error) => {
        result = { ok, payload: payload as { key: string } | undefined, error };
      },
    });
    if (!result) {
      throw new Error("sessions.create did not respond");
    }
    return result;
  };

  try {
    const first = await request();
    const replay = await request(
      {
        message: params.message,
        permissionMode: params.permissionMode,
        idempotencyKey: params.idempotencyKey,
        agentId: params.agentId,
      },
      {
        ...client,
        connect: {
          ...client.connect,
          scopes: ["operator.admin", "operator.read", "operator.write"],
        },
      },
    );

    expect(first.ok).toBe(true);
    expect(replay).toEqual(first);
    expect(chatSend).toHaveBeenCalledOnce();
    expect(chatSend.mock.calls[0]?.[0].params).toMatchObject({
      idempotencyKey: expect.any(String),
      message: "start this task exactly once",
    });

    const conflict = await request({ ...params, message: "start a different task" });
    expect(conflict).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "session creation idempotency key was reused with different parameters",
      },
    });
    expect(chatSend).toHaveBeenCalledOnce();

    const downgraded = await request(params, {
      ...client,
      connect: { ...client.connect, scopes: ["operator.write"] },
    });
    expect(downgraded).toMatchObject({
      ok: false,
      error: { message: "missing scope: operator.admin" },
    });
    expect(chatSend).toHaveBeenCalledOnce();

    const differentOwner = await request(params, {
      ...client,
      authenticatedUserProfile: { profileId: ensureProfileForEmail("other@owner.test").id },
    });
    expect(differentOwner.ok).toBe(true);
    expect(differentOwner.payload?.key).not.toBe(first.payload?.key);
    expect(chatSend).toHaveBeenCalledTimes(2);
    expect(chatSend.mock.calls[1]?.[0].params.idempotencyKey).not.toBe(
      chatSend.mock.calls[0]?.[0].params.idempotencyKey,
    );
  } finally {
    chatSend.mockRestore();
  }
});
