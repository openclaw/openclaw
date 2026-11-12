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
  toDatabaseOptions,
  withSqliteSessionDatabase,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  createGatewayActiveWorkSnapshot,
  waitForGatewayActiveWork,
} from "../infra/gateway-active-work.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../sessions/session-controller.operation.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "./device-revocation.js";
import {
  setupPersistentSessionCreateTestHarness,
  removeSessionWorktree,
  chatSendOwner,
  sessionCreateRuntimeClient,
} from "./server.sessions.create.test-support.js";
import { readSessionGroupCatalog } from "./session-group-catalog.js";
import * as sharingAuthorization from "./session-sharing-authorization-async.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { embeddedRunMock, rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  sessionStoreEntry,
  directSessionReq,
  sessionHookMocks,
  sessionLifecycleHookMocks,
  beforeResetHookMocks,
  beforeResetHookState,
} from "./test/server-sessions.test-helpers.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
const publicationBoundary = vi.hoisted(
  (): {
    afterCold: (() => Promise<void>) | undefined;
    afterWarm: (() => Promise<void>) | undefined;
  } => ({ afterCold: undefined, afterWarm: undefined }),
);

vi.mock("./server-methods/session-create-idempotency.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./server-methods/session-create-idempotency.js")>();
  const idempotentSessionCreate: typeof actual.idempotentSessionCreate = (handler, replay) =>
    actual.idempotentSessionCreate(
      async (request) => {
        await handler(request);
        await publicationBoundary.afterCold?.();
      },
      replay
        ? async (request, result) => {
            const replayed = await replay(request, result);
            await publicationBoundary.afterWarm?.();
            return replayed;
          }
        : undefined,
    );
  return { ...actual, idempotentSessionCreate };
});

const { createSessionStoreDir, openClient } = setupPersistentSessionCreateTestHarness();
let storePath: string;
beforeEach(async () => {
  publicationBoundary.afterCold = undefined;
  publicationBoundary.afterWarm = undefined;
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
    const restarted = await directSessionReq<{ key: string }>("sessions.create", params, {
      client: clientFor() as never,
      context: { dedupe: new Map() },
    });
    expectOk(restarted);
    expect(restarted.payload?.key).toBe(first.payload?.key);
    expect(chatSend).toHaveBeenCalledOnce();
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

test("durable creation replays before label claims and refuses a reset incarnation", async () => {
  const client = {
    connect: {
      role: "operator",
      scopes: ["operator.write", "operator.admin"],
      device: { id: "receipt-device" },
    },
    authenticatedUserProfile: { profileId: ensureProfileForEmail("receipt-owner@example.test").id },
  };
  const params = {
    agentId: "main",
    label: "Receipt original",
    idempotencyKey: "receipt-label-once",
  };
  const request = (scopes = client.connect.scopes) =>
    directSessionReq<CreatedSession>("sessions.create", params, {
      client: { ...client, connect: { ...client.connect, scopes } } as never,
      context: { dedupe: new Map() },
    });
  const first = await request();
  expectOk(first);
  const created = first.payload!;
  expectOk(
    await directSessionReq(
      "sessions.patch",
      { key: created.key, label: "Renamed original" },
      { client: client as never },
    ),
  );
  expectOk(
    await directSessionReq(
      "sessions.create",
      { agentId: "main", label: params.label },
      { client: client as never },
    ),
  );
  const replay = await request();
  expect(replay).toMatchObject({
    ok: true,
    payload: {
      key: created.key,
      sessionId: created.sessionId,
      entry: { label: "Renamed original" },
      runStarted: false,
      creationReplayed: true,
    },
  });
  expect(await request(["operator.write"])).toMatchObject({
    ok: false,
    error: { code: "FORBIDDEN" },
  });
  expectOk(
    await directSessionReq("sessions.reset", { key: created.key }, { client: client as never }),
  );
  expect(readEntry(created.key)?.sessionId).toBe(created.sessionId);
  expect(await request()).toMatchObject({
    ok: false,
    error: { message: "The original creation incarnation is no longer available." },
  });
});

test.each(["requester", "membership"] as const)(
  "durable replay refuses %s revocation after authorization and before metadata disclosure",
  async (change) => {
    const client = roleClient("view", "durable-replay-member");
    const profileId = client.authenticatedUserProfile!.profileId;
    const creator = ensureProfileForEmail("durable-replay-creator@example.test").id;
    const key = "agent:main:dashboard:restricted-replay";
    const scope = { agentId: "main", storePath, sessionKey: key };
    replaceSessionEntrySync(scope, {
      sessionId: "restricted-original",
      lifecycleRevision: "original",
      updatedAt: 1,
      label: "Private replay metadata",
      visibility: "read-only",
      createdActor: { type: "human", source: "profile", id: creator },
    });
    await addSessionMember(scope, { identityId: profileId, addedBy: creator });
    const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
    const deviceOwner = {};
    const source = captureGatewayDeviceRevocation(
      deviceOwner,
      { deviceId: "replay-device", role: "operator" },
      () => true,
    );
    const request = () =>
      directSessionReq<CreatedSession>(
        "sessions.create",
        {
          agentId: "main",
          key,
          idempotencyKey: "restricted-replay-once",
        },
        {
          client,
          hasCurrentClientAuthority: source.isCurrent,
          // Distinct context removes the process-local cache without manufacturing a receipt.
          context: { dedupe: new Map(), getRuntimeConfig: () => cfg },
        },
      );
    try {
      expectOk(await request());
      expect(await request()).toMatchObject({
        ok: true,
        payload: {
          key,
          sessionId: "restricted-original",
          creationReplayed: true,
          entry: { label: "Private replay metadata" },
        },
      });
      const authorize = sharingAuthorization.resolveSessionMutationAuthorizationAsync;
      let revoked = false;
      // Delay only completion: real policy, membership writer, and revocation owner run unchanged.
      using _ = vi
        .spyOn(sharingAuthorization, "resolveSessionMutationAuthorizationAsync")
        .mockImplementation(async (input) => {
          const result = await authorize(input);
          if (input.method === "sessions.create" && input.expectedTarget && !revoked) {
            expect(result.error).toBeNull();
            expect(result.authorization).toBeDefined();
            revoked = true;
            if (change === "requester") {
              invalidateGatewayDeviceRevocation(deviceOwner, "replay-device", "operator");
            } else {
              expect(await removeSessionMember(scope, profileId)).toMatchObject({
                identityId: profileId,
              });
            }
          }
          return result;
        });
      const refused = await request();
      expect(revoked).toBe(true);
      expect(refused).toMatchObject({ ok: false });
      expect(refused.payload).toBeUndefined();
      expect(JSON.stringify(refused)).not.toContain("Private replay metadata");
      expect(readEntry(key)?.sessionId).toBe("restricted-original");
      console.info(
        `PASS durable replay ${change} revoked after live authorization: no session metadata disclosed`,
      );
    } finally {
      source.release();
    }
  },
);

test.each(["cold", "warm"] as const)(
  "durable %s replay refuses membership removal at final response publication",
  async (cache) => {
    const client = roleClient("view", "publication-replay-member");
    const profileId = client.authenticatedUserProfile!.profileId;
    const creator = ensureProfileForEmail("publication-replay-creator@example.test").id;
    const key = "agent:main:dashboard:publication-replay";
    const scope = { agentId: "main", storePath, sessionKey: key };
    replaceSessionEntrySync(scope, {
      sessionId: "publication-original",
      lifecycleRevision: "publication-original",
      updatedAt: 1,
      label: "Original replay metadata",
      visibility: "read-only",
      createdActor: { type: "human", source: "profile", id: creator },
    });
    await addSessionMember(scope, { identityId: profileId, addedBy: creator });
    const cfg = { ...getRuntimeConfig(), ...rolePolicyConfig() };
    const context = { dedupe: new Map(), getRuntimeConfig: () => cfg };
    const request = () =>
      directSessionReq<CreatedSession>(
        "sessions.create",
        { agentId: "main", key, idempotencyKey: "publication-replay-once" },
        {
          client,
          context: cache === "warm" ? context : { ...context, dedupe: new Map() },
        },
      );
    expectOk(await request());
    expect(await request()).toMatchObject({
      ok: true,
      payload: {
        key,
        sessionId: "publication-original",
        entry: { label: "Original replay metadata" },
      },
    });
    let removals = 0;
    // Decorate only completion: real replay authorization, idempotency, and membership writes run.
    // The handoff remains after replay preparation even when cleanup moves past publication.
    publicationBoundary[cache === "warm" ? "afterWarm" : "afterCold"] = async () => {
      expect(await removeSessionMember(scope, profileId)).toMatchObject({ identityId: profileId });
      removals++;
    };
    const denied = await request();
    expect(removals).toBe(1);
    expect(denied).toMatchObject({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        details: { code: "SESSION_PARTICIPATION_REQUIRED" },
      },
    });
    expect(denied.payload).toBeUndefined();
    expect(JSON.stringify(denied)).not.toContain("Original replay metadata");
    expect(readEntry(key)?.sessionId).toBe("publication-original");
    console.info(
      `PASS ${cache} replay membership removal at final callback: no metadata published`,
    );
  },
);

test.each(["new-session", "reset"] as const)(
  "warm replay uses the replacement receipt for %s",
  async (replacement) => {
    const client = {
      connect: { role: "operator", scopes: ["operator.write", "operator.admin"] },
      authenticatedUserProfile: {
        profileId: ensureProfileForEmail("receipt-replacement@example.test").id,
      },
    };
    const params = {
      agentId: "main",
      idempotencyKey: `replace-expired-receipt-${replacement}`,
      ...(replacement === "reset" ? { key: "agent:main:dashboard:receipt-reset" } : {}),
    };
    const warmContext = { dedupe: new Map() };
    const request = (context = { dedupe: new Map() }) =>
      directSessionReq<CreatedSession>("sessions.create", params, {
        client: client as never,
        context,
      });
    const original = await request();
    expect(original.ok, `original create: ${JSON.stringify(original.error)}`).toBe(true);
    const first = original.payload!;
    expect(await request(warmContext)).toMatchObject({
      ok: true,
      payload: { key: first.key, sessionId: first.sessionId },
    });
    // Advance only the persisted retention deadline. Both incarnations and receipts
    // still come from the public handlers; the independent warm cache stays live.
    const scope = resolveSqliteStoreScope(storePath, { agentId: "main" });
    await runExclusiveSqliteSessionWrite(
      scope,
      async () => {
        await withSqliteSessionDatabase(toDatabaseOptions(scope), ({ db }) =>
          db
            .prepare("UPDATE session_creation_operations SET expires_at = ? WHERE session_key = ?")
            .run(Date.now() - 1, first.key),
        );
      },
      "session.entry.create-with-transcript",
    );
    if (replacement === "reset") {
      const reset = await directSessionReq(
        "sessions.reset",
        { key: first.key },
        { client: client as never },
      );
      expect(reset.ok, `reset: ${JSON.stringify(reset.error)}`).toBe(true);
    }
    const next = await request();
    expect(next.ok, `replacement create: ${JSON.stringify(next.error)}`).toBe(true);
    if (replacement === "reset") {
      expect(next.payload?.sessionId).toBe(first.sessionId);
      expect(next.payload?.entry.lifecycleRevision).not.toBe(first.entry.lifecycleRevision);
    } else {
      expect(next.payload?.key).not.toBe(first.key);
      expect(next.payload?.sessionId).not.toBe(first.sessionId);
    }
    const replay = await request(warmContext);
    expect(replay.ok, `warm replay: ${JSON.stringify(replay.error)}`).toBe(true);
    expect(replay.payload).toMatchObject({
      key: next.payload!.key,
      sessionId: next.payload!.sessionId,
      creationReplayed: true,
      runStarted: false,
    });
    expect(replay.payload?.entry.lifecycleRevision).toBe(next.payload?.entry.lifecycleRevision);
    expect(readEntry(next.payload!.key)?.sessionId).toBe(next.payload?.sessionId);
  },
);

test.each([
  { parentKey: "agent:main:dashboard:busy", worktree: false },
  { parentKey: "agent:main:main", worktree: false },
  { parentKey: "agent:main:dashboard:busy", worktree: true },
])(
  "sessions.create preserves active $parentKey with worktree=$worktree",
  async ({ parentKey, worktree }) => {
    const parentSessionId = "sess-active-parallel-parent";
    const previousSessionConfig = testState.sessionConfig;
    testState.sessionConfig = { dmScope: "main" };
    await writeSessionStore({
      entries: {
        [parentKey]: sessionStoreEntry(parentSessionId, {
          providerOverride: "anthropic",
          modelOverride: "parent-model",
          modelOverrideSource: "user",
          thinkingLevel: "high",
          fastMode: true,
        }),
      },
    });
    beforeResetHookState.hasBeforeResetHook = true;
    const parentOperation = createReplyOperation({
      sessionKey: parentKey,
      sessionId: parentSessionId,
      agentId: "main",
      resetTriggered: false,
      target: captureSessionTarget({
        storeScope: storePath,
        sessionKey: parentKey,
        incarnation: parentSessionId,
        agentId: "main",
      }),
    });
    parentOperation.setPhase("running");
    // Model a producer that releases custody when reset requests cancellation.
    parentOperation.abortSignal.addEventListener("abort", () => parentOperation.complete(), {
      once: true,
    });
    let createdKey: string | undefined;
    try {
      const created = await directSessionReq<CreatedSession>(
        "sessions.create",
        {
          agentId: "main",
          parentSessionKey: parentKey,
          emitCommandHooks: true,
          succeedsParent: false,
          ...(worktree ? { worktree: true, worktreeSource: "empty" } : {}),
        },
        adminClient(),
      );
      createdKey = created.payload?.key;
      if (worktree) {
        expect(created).toMatchObject({
          ok: false,
          error: { code: "UNAVAILABLE", message: expect.stringContaining("active") },
        });
      } else {
        expect(created.ok, JSON.stringify(created.error)).toBe(true);
        expect(created.payload?.key).toMatch(/^agent:main:dashboard:/);
        expect(created.payload?.key).not.toBe(parentKey);
        expect(created.payload?.entry).toMatchObject({
          parentSessionKey: parentKey,
          providerOverride: "anthropic",
          modelOverride: "parent-model",
          thinkingLevel: "high",
          fastMode: true,
        });
      }
      expect(readEntry(parentKey)?.sessionId).toBe(parentSessionId);
      expect(parentOperation.phase).toBe("running");
      expect(parentOperation.abortSignal.aborted).toBe(false);
      expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
      expect(beforeResetHookMocks.runBeforeReset).not.toHaveBeenCalled();
      expect(sessionLifecycleHookMocks.runSessionEnd).not.toHaveBeenCalled();
      if (worktree) {
        expect(sessionLifecycleHookMocks.runSessionStart).not.toHaveBeenCalled();
      } else {
        expect(sessionLifecycleHookMocks.runSessionStart.mock.calls[0]?.[0]).toMatchObject({
          sessionKey: created.payload?.key,
        });
      }
    } finally {
      parentOperation.complete();
      if (worktree && createdKey) {
        await removeSessionWorktree(createdKey);
      }
      testState.sessionConfig = previousSessionConfig;
    }
  },
);
