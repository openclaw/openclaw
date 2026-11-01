import { beforeEach, expect, test, vi } from "vitest";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import * as modelRuntime from "../auto-reply/reply/model-runtime-normalization.js";
import { persistReplySessionEntry } from "../auto-reply/reply/session-entry-persistence.js";
import { getRuntimeConfig } from "../config/io.js";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteStoreScope,
  runExclusiveSqliteSessionWrite,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  createGatewayActiveWorkSnapshot,
  waitForGatewayActiveWork,
} from "../infra/gateway-active-work.js";
import { beginSessionEffect } from "../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  setupPersistentSessionCreateTestHarness,
  chatSendOwner,
  sessionCreateRuntimeClient,
} from "./server.sessions.create.test-support.js";
import { readSessionGroupCatalog } from "./session-group-catalog.js";
import { embeddedRunMock, rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  sessionStoreEntry,
  directSessionReq,
  sessionHookMocks,
  sessionLifecycleHookMocks,
} from "./test/server-sessions.test-helpers.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
const { createSessionStoreDir, openClient } = setupPersistentSessionCreateTestHarness();
let storePath: string;
beforeEach(async () => {
  ({ storePath } = await createSessionStoreDir());
});

type CreatedSession = { key: string; sessionId: string; entry: SessionEntry; runStarted?: boolean };
type CreateParams = Parameters<
  (typeof import("./session-create-service.js"))["createGatewaySession"]
>[0];
const adminClient = () => ({ client: { connect: { scopes: ["operator.admin"] } } as never });
const writeClient = () => ({ client: { connect: { scopes: ["operator.write"] } } as never });
const mainReset = { parentSessionKey: "main", emitCommandHooks: true };
const expectOk = (result: { ok: boolean }) => expect(result.ok).toBe(true);
const missingAdmin = {
  ok: false,
  error: { code: "FORBIDDEN", message: "missing scope: operator.admin" },
};
const invalidCreate = (field: string) => ({
  ok: false,
  error: { code: "INVALID_REQUEST", message: `sessions.create ${field} requires a new session` },
});

function createSession(
  params: Record<string, unknown>,
  options?: Parameters<typeof directSessionReq<CreatedSession>>[2],
) {
  return directSessionReq<CreatedSession>(
    "sessions.create",
    { agentId: "main", ...params },
    options,
  );
}

async function resetMain(params: Partial<CreateParams>) {
  const { createGatewaySession } = await import("./session-create-service.js");
  return createGatewaySession({
    cfg: getRuntimeConfig(),
    agentId: "main",
    ...mainReset,
    resetMainWhenUnspecified: true,
    commandSource: "test",
    ...params,
  });
}

async function seedMain(
  sessionId: string,
  options?: Parameters<typeof sessionStoreEntry>[1],
  key = "main",
) {
  await writeSessionStore({ entries: { [key]: sessionStoreEntry(sessionId, options) } });
}

function readEntry(sessionKey = "agent:main:main") {
  return loadSessionEntry({ agentId: "main", sessionKey, storePath });
}

test.for([
  { model: "openai/gpt-5.6-sol" },
  {
    nativeRuntimeConsent: "native-fixture",
    permissionMode: "full",
    sandboxMode: "off",
    expectedPermissionMode: null,
    expectedSandboxMode: null,
    expectedNativeRuntimeConsent: null,
  },
])(
  "sessions.create stays available while runtime selection waits for %j",
  async (patch, { signal }) => {
    const blockedKey = "agent:main:dashboard:pending-runtime";
    const createdKey = "agent:main:dashboard:independent-runtime";
    const original = sessionStoreEntry("pending-runtime", {
      lifecycleRevision: "runtime-generation",
    });
    await writeSessionStore({ entries: { [blockedKey]: original } });
    const { ws } = await openClient();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const preparation = vi
      .spyOn(modelRuntime, "prepareModelSelectionRuntime")
      .mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { status: "rejected", reason: "invalid-runtime", message: "Runtime unavailable" };
      });
    const context = {
      loadGatewayModelCatalog: async () => [
        { id: "gpt-5.6-sol", provider: "openai", name: "GPT 5.6 Sol" },
      ],
    };
    const changing = directSessionReq(
      "sessions.patch",
      {
        key: blockedKey,
        expectedSessionId: original.sessionId,
        expectedLifecycleRevision: original.lifecycleRevision,
        ...patch,
      },
      { context },
    );
    let creating: ReturnType<typeof rpcReq> | undefined;
    let successor: ReturnType<typeof directSessionReq> | undefined;
    let successorFinished = false;
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, changing, "Runtime selection was not reached"),
        signal,
      );
      expect(createGatewayActiveWorkSnapshot().counts.sessionMutations).toBe(1);
      successor = directSessionReq(
        "sessions.patch",
        { key: blockedKey, pinned: true },
        { context },
      );
      void successor.then(() => {
        successorFinished = true;
      });
      creating = rpcReq(ws, "sessions.create", { key: createdKey, agentId: "main" });
      expectOk(await withinTest(creating, signal));
      expect(successorFinished).toBe(false);
      const created = readEntry(createdKey);
      expect(created?.sessionId).toBeTruthy();
      expectOk(await rpcReq(ws, "sessions.patch", { key: createdKey, pinned: true }));
      expect(readEntry(createdKey)?.pinnedAt).toEqual(expect.any(Number));
    } finally {
      release.resolve();
      await Promise.allSettled([changing, creating, successor]);
      preparation.mockRestore();
      await closeGatewayTestWebSocket(ws);
    }
    expect(await changing).toMatchObject({
      ok: false,
      error: { message: "Runtime unavailable" },
    });
    expect(await successor).toMatchObject({ ok: true });
    expect(createGatewayActiveWorkSnapshot().counts.sessionMutations).toBe(0);
    // Client closure does not settle detached connect work.
    expect(await waitForGatewayActiveWork(5_000)).toMatchObject({
      drained: true,
      snapshot: { idle: true, blockers: [] },
    });
  },
);

test("sessions.create registers a category only after the session commit succeeds", async () => {
  const category = "Deferred category";
  let validations = 0;
  const failed = await createSession(
    { category, key: "agent:main:dashboard:failed-category-create" },
    {
      context: {
        validateAgentRuntimeApprovalAuthority: () => ++validations < 3,
      },
      client: sessionCreateRuntimeClient(["operator.write"]) as never,
    },
  );
  expect(failed.ok).toBe(false);
  expect(readSessionGroupCatalog().groups.map((group) => group.name)).not.toContain(category);
  const broadcastToConnIds = vi.fn();
  const created = await createSession(
    { category: `  ${category}  `, key: "agent:main:dashboard:created" },
    {
      context: {
        broadcastToConnIds,
        getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      },
    },
  );
  expectOk(created);
  expect(readSessionGroupCatalog().groups.filter((group) => group.name === category)).toHaveLength(
    1,
  );
  expect(
    broadcastToConnIds.mock.calls.filter(([, payload]) => payload?.reason === "groups"),
  ).toHaveLength(1);
});

test("concurrent sessions.create requests adopt one canonical keyed session", async () => {
  const key = "agent:main:dashboard:concurrent-keyed-session";
  const sql = observeHostDataSql();
  let created: Awaited<ReturnType<typeof createSession>>[];
  try {
    created = await Promise.all(Array.from({ length: 4 }, () => createSession({ key })));
    expect(sql.queries.filter((query) => /\bfrom\s+"?session_nodes\b/i.test(query))).toEqual([]);
  } finally {
    sql.restore();
  }
  expect(created.every((result) => result.ok)).toBe(true);
  expect(new Set(created.map((result) => result.payload?.key))).toEqual(new Set([key]));
  const sessionIds = new Set(created.map((result) => result.payload?.sessionId));
  expect(sessionIds.size).toBe(1);
  const persistedSessionId = loadSessionEntry({ sessionKey: key, storePath })?.sessionId;
  const canonicalSessionId = created[0]?.payload?.sessionId;
  expect(persistedSessionId).toBe(canonicalSessionId);
});

test("createGatewaySession forwards its commit guard into main-session reset", async () => {
  try {
    const key = "agent:main:main";
    const original = sessionStoreEntry("main-before-guard-close");
    testState.sessionConfig = { dmScope: "main" };
    await writeSessionStore({ entries: { main: original } });
    const commitGuard = vi.fn(() => {
      if (commitGuard.mock.calls.length > 1) {
        throw new Error("session create authority closed");
      }
    });
    await expect(resetMain({ commitGuard })).rejects.toThrow("session create authority closed");
    expect(commitGuard).toHaveBeenCalledTimes(2);
    expect(readEntry(key)).toMatchObject(original);
  } finally {
    testState.sessionConfig = undefined;
  }
});

test("sessions.create preserves keyed draft adoption idempotency", async () => {
  const key = "agent:main:dashboard:idempotent-draft";
  const first = await createSession({ key, visibility: "draft" });
  expectOk(first);
  const retried = await createSession({ key, visibility: "draft" });
  const expected = {
    ok: true,
    payload: {
      sessionId: first.payload?.sessionId,
      entry: { visibility: "draft" },
    },
  };
  expect(retried).toMatchObject(expected);
  testState.sessionConfig = { sharing: { drafts: false } };
  const retriedAfterPolicyChange = await createSession({ key, visibility: "draft" });
  expect(retriedAfterPolicyChange).toMatchObject(expected);
  const mismatch = await createSession({ key, visibility: "shared" });
  expect(mismatch).toMatchObject(invalidCreate("visibility"));
});

test("sessions.create persists explicit tool overrides before the first turn", async () => {
  const parentSessionKey = "agent:main:main";
  await seedMain(
    "tool-overrides-parent",
    {
      toolOverrides: { skills: { inherited: false } },
    },
    parentSessionKey,
  );
  const sessionKey = "agent:main:dashboard:create-tool-overrides";
  const requested = {
    mcpServers: { zeta: false, alpha: true },
    mcpToolsDeny: { github: ["write", "read", "write"] },
    skills: { release: false },
    webSearch: false,
  };
  const normalized = {
    ...requested,
    mcpServers: { alpha: true, zeta: false },
    mcpToolsDeny: { github: ["read", "write"] },
  };
  const observed: Array<unknown> = [];
  const chatSend = vi.spyOn(chatSendOwner, "handleDirectExternalChatSend");
  chatSend.mockImplementation(async ({ respond }) => {
    observed.push(readEntry(sessionKey)?.toolOverrides);
    respond(true, { runId: "create-tool-overrides-run", status: "started" });
  });
  const client = adminClient();
  try {
    const created = await createSession(
      {
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
    expect(readEntry(sessionKey)?.toolOverrides).toEqual(normalized);
    const retried = await createSession({ key: sessionKey, toolOverrides: requested }, client);
    expectOk(retried);
    const mismatch = await createSession(
      { key: sessionKey, toolOverrides: { skills: { release: true } } },
      client,
    );
    expect(mismatch).toMatchObject(invalidCreate("toolOverrides"));
  } finally {
    chatSend.mockRestore();
  }
});

test("sessions.create reset-in-place clears a prior node binding for Gateway execution", async () => {
  testState.sessionConfig = { dmScope: "main" };
  await seedMain("sess-node-parent");
  const nodeSession = await createSession(
    {
      ...mainReset,
      execNode: "macbook",
      cwd: "/Users/peter/Projects/openclaw",
    },
    adminClient(),
  );
  expectOk(nodeSession);
  expect(nodeSession.payload?.entry).toMatchObject({
    execHost: "node",
    execNode: "macbook",
    execCwd: "/Users/peter/Projects/openclaw",
  });
  expect(nodeSession.payload?.entry.spawnedCwd).toBeUndefined();
  const gatewaySession = await createSession(mainReset, writeClient());
  expectOk(gatewaySession);
  const cleared = gatewaySession.payload?.entry;
  expect([cleared?.execHost, cleared?.execNode, cleared?.execCwd]).toEqual(
    Array(3).fill(undefined),
  );
});

test("sessions.create reset-in-place applies Fast Mode only for admin callers", async () => {
  testState.sessionConfig = { dmScope: "main" };
  const provenance = {
    createdVia: "channel",
    createdActor: { type: "human", source: "channel", id: "telegram:42" },
    createdAt: 1234,
  } as const;
  await seedMain("sess-fast-reset", { fastMode: false, ...provenance });
  const params = { ...mainReset, fastMode: true };
  const denied = await createSession(params, writeClient());
  expect(denied).toMatchObject(missingAdmin);
  expect(readEntry()).toMatchObject({ sessionId: "sess-fast-reset", fastMode: false });
  const changed = await createSession(params, adminClient());
  expect(changed.ok, JSON.stringify(changed.error)).toBe(true);
  expect(changed.payload?.entry.fastMode).toBe(true);
  expect(readEntry()).toMatchObject({ fastMode: true, ...provenance });
});

test("sessions.create rechecks Fast Mode before interrupting reset work", async () => {
  testState.sessionConfig = { dmScope: "main" };
  const key = "agent:main:main";
  await seedMain("sess-fast-race", { fastMode: false });
  let interrupted = false;
  let releaseAdmission = () => {};
  const admission = await beginSessionEffect({
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
    const current = readEntry(key);
    if (!current) {
      throw new Error("expected current main session");
    }
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key, storePath },
      { ...current, fastMode: true },
    );
  };
  try {
    const denied = await resetMain({
      fastMode: false,
      requestingOperatorScopes: ["operator.write"],
      allowExistingModelSelection: false,
      commitGuard,
    });
    expect(denied).toMatchObject(missingAdmin);
    expect(interrupted).toBe(false);
    expect(readEntry(key)).toMatchObject({
      sessionId: "sess-fast-race",
      fastMode: true,
    });
  } finally {
    admission.release();
  }
});
test("sessions.create rejects a Fast Mode change completed by draining work before reset cleanup", async () => {
  const key = "agent:main:main";
  const initialEntry = sessionStoreEntry("sess-fast-drain", { fastMode: false });
  await writeSessionStore({ entries: { main: initialEntry } });
  const placements = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
  const claim = await placements.claimTurn({
    agentId: "main",
    sessionKey: key,
    sessionId: initialEntry.sessionId,
    owner: { kind: "local" },
    claimId: "fast-drain-claim",
    runId: "fast-drain-run",
  });
  const interrupted = createDeferredCore();
  const admission = await beginSessionEffect({
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
    await placements.releaseTurn(claim);
    admission.release();
    expect(await reset).toMatchObject(missingAdmin);
    expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
    expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
    expect(embeddedRunMock.abortCalls).toEqual([]);
    expect(placements.get(initialEntry.sessionId)).toMatchObject({ state: "local" });
    expect(readEntry(key)).toMatchObject({
      sessionId: initialEntry.sessionId,
      fastMode: true,
    });
  } finally {
    releaseWriter.resolve();
    await heldWriter;
    if (placements.validateTurnClaim(claim)) {
      await placements.releaseTurn(claim);
    }
    admission.release();
    await reset;
  }
});

test("sessions.reset preserves the recorded permission boundary", async () => {
  await seedMain("sess-permission-reset", {
    permissionMode: "guarded",
    sessionRoot: "/workspace/project",
  });
  const reset = await directSessionReq<CreatedSession>("sessions.reset", { key: "main" });
  expect(reset).toMatchObject({
    ok: true,
    payload: { entry: { permissionMode: "guarded", sessionRoot: "/workspace/project" } },
  });
});

test("sessions.create does not apply create-time visibility to an in-place reset", async () => {
  testState.sessionConfig = { dmScope: "main" };
  await seedMain("sess-existing-main");
  const reset = await createSession({ ...mainReset, visibility: "draft" });
  expect(reset).toMatchObject(invalidCreate("visibility"));
});

test("sessions.create replays an identical creation once and rejects conflicting intent", async () => {
  const chatSend = vi.spyOn(chatSendOwner, "handleDirectExternalChatSend");
  chatSend.mockImplementation(async ({ respond }) => {
    respond(true, { runId: "create-once", status: "started" });
  });
  const context = { dedupe: new Map() };
  const ownerId = ensureProfileForEmail("replay@owner.test").id;
  const clientFor = (scopes = ["operator.write", "operator.admin"], profileId = ownerId) => ({
    connect: {
      role: "operator",
      scopes,
      device: { id: "control-ui-device" },
    },
    authenticatedUserProfile: { profileId },
  });
  const params = {
    agentId: "main",
    idempotencyKey: "create-once",
    message: "start this task exactly once",
    permissionMode: "full",
  };
  const request = (nextParams = params, nextClient = clientFor()) =>
    directSessionReq<{ key: string }>("sessions.create", nextParams, {
      client: nextClient as never,
      context,
    });
  try {
    const first = await request();
    const replay = await request(
      {
        message: params.message,
        permissionMode: params.permissionMode,
        idempotencyKey: params.idempotencyKey,
        agentId: params.agentId,
      },
      clientFor(["operator.admin", "operator.read", "operator.write"]),
    );
    expectOk(first);
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
    const downgraded = await request(params, clientFor(["operator.write"]));
    expect(downgraded).toMatchObject({
      ok: false,
      error: { message: "missing scope: operator.admin" },
    });
    expect(chatSend).toHaveBeenCalledOnce();
    const differentOwner = await request(
      params,
      clientFor(undefined, ensureProfileForEmail("other@owner.test").id),
    );
    expectOk(differentOwner);
    expect(differentOwner.payload?.key).not.toBe(first.payload?.key);
    expect(chatSend).toHaveBeenCalledTimes(2);
    expect(chatSend.mock.calls[1]?.[0].params.idempotencyKey).not.toBe(
      chatSend.mock.calls[0]?.[0].params.idempotencyKey,
    );
  } finally {
    chatSend.mockRestore();
  }
});
