// Session RPC permissions, hook isolation, and negotiated wire compatibility.
import { expect, test } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { getRuntimeConfig } from "../config/io.js";
import {
  listSessionEntriesCore,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { isSessionPatchEvent } from "../hooks/internal-hooks.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import {
  agentDiscoveryMock,
  connectWebchatClient,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionHookMocks,
  sessionStoreEntry,
  isInternalHookEvent,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient, getHarness, seedActiveMainSession } =
  setupGatewaySessionsTestHarness();
type PermissionClient = NonNullable<Parameters<typeof connectWebchatClient>[0]["client"]>;

async function openPermissionClient(
  client: Pick<PermissionClient, "id" | "mode"> & { scopes?: string[] },
) {
  return await connectWebchatClient({
    port: getHarness().port,
    scopes: client.scopes,
    client: {
      id: client.id,
      version: "1.0.0",
      platform: "test",
      mode: client.mode,
    },
  });
}

async function createPermissionSessionStore() {
  const { storePath } = await createSessionStoreDir();
  await upsertSessionEntryCore(
    { sessionKey: "agent:main:main", storePath },
    sessionStoreEntry("main-session"),
  );
  await upsertSessionEntryCore(
    { sessionKey: "agent:main:discord:group:dev", storePath },
    sessionStoreEntry("sess-group"),
  );
  return { storePath };
}

test("webchat session mutations follow operator scope policy", async () => {
  const { storePath } = await createPermissionSessionStore();

  const ws = await openPermissionClient({
    id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
    mode: GATEWAY_CLIENT_MODES.UI,
    scopes: ["operator.read"],
  });

  const deniedMutations = [
    [
      "sessions.patch",
      { key: "agent:main:discord:group:dev", label: "should-fail" },
      "operator.write",
    ],
    ["sessions.delete", { key: "agent:main:discord:group:dev" }, "operator.admin"],
    ["sessions.compact", { key: "main", maxLines: 3 }, "operator.admin"],
    [
      "sessions.branches.switch",
      { sessionKey: "agent:main:main", leafEntryId: "entry-1" },
      "operator.admin",
    ],
    ["sessions.rewind", { sessionKey: "agent:main:main", entryId: "entry-1" }, "operator.admin"],
    ["sessions.fork", { sessionKey: "agent:main:main", entryId: "entry-1" }, "operator.write"],
    ["sessions.dispatch", { key: "agent:main:main", profileId: "test" }, "operator.admin"],
    ["sessions.dispatch", { key: "agent:main:main", deviceId: "device-1" }, "operator.write"],
    ["sessions.reclaim", { key: "agent:main:main" }, "operator.write"],
    [
      "sessions.move",
      {
        key: "agent:main:main",
        expected: { generation: 1, environmentId: "environment-1", ownerEpoch: 1 },
        target: { kind: "gateway" },
      },
      "operator.write",
    ],
    [
      "sessions.pluginPatch",
      { key: "agent:main:main", pluginId: "test-plugin", namespace: "test", value: true },
      "operator.admin",
    ],
  ] as const;
  for (const [method, params, missingScope] of deniedMutations) {
    const result = await rpcReq(ws, method, params);
    expect(result.ok, method).toBe(false);
    expect(result.error, method).toEqual({
      code: "FORBIDDEN",
      message: `missing scope: ${missingScope}`,
      details: { code: "MISSING_SCOPE", missingScope, requiredScopes: [missingScope] },
    });
  }

  expect(
    listSessionEntriesCore({ storePath })
      .map(({ sessionKey }) => sessionKey)
      .toSorted(),
  ).toEqual(["agent:main:discord:group:dev", "agent:main:main"]);

  expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  ws.close();
});

test("session:patch hook mutations cannot change the response path", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-cfg-isolation-test"),
    },
  });

  sessionHookMocks.triggerInternalHook.mockImplementationOnce(async (event) => {
    if (!isInternalHookEvent(event) || !isSessionPatchEvent(event)) {
      return;
    }
    event.context.cfg.agents = {
      ...event.context.cfg.agents,
      defaults: {
        ...event.context.cfg.agents?.defaults,
        model: "zai/glm-4.6",
      },
    };
  });

  const { ws } = await openClient();
  const patched = await rpcReq<{
    entry: { label?: string };
    key: string;
    resolved: {
      modelProvider: string;
      model: string;
      agentRuntime: { id: string; source: string };
    };
  }>(ws, "sessions.patch", {
    key: "agent:main:main",
    label: "cfg-isolation",
  });

  expect(patched.ok).toBe(true);
  expect(sessionHookMocks.triggerInternalHook).toHaveBeenCalledOnce();
  expect(sessionHookMocks.triggerInternalHook.mock.calls[0]?.[0]).toMatchObject({
    type: "session",
    action: "patch",
    sessionKey: "agent:main:main",
    context: {
      sessionEntry: { sessionId: "sess-cfg-isolation-test", label: "cfg-isolation" },
      patch: { label: "cfg-isolation" },
    },
  });
  expect(patched.payload?.resolved).toEqual({
    modelProvider: "anthropic",
    model: "claude-opus-4-6",
    agentRuntime: { id: "openclaw", source: "implicit" },
    runtimeSelectionLocked: false,
  });
  expect(patched.payload?.entry.label).toBe("cfg-isolation");

  ws.close();
});

test("sessions.patch stores and clears rootless modes while preserving recorded roots", async () => {
  const { storePath } = await createSessionStoreDir();
  const pinnedSessionKey = "agent:main:dashboard:pinned-permission";
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-rootless-permission"),
      [pinnedSessionKey]: sessionStoreEntry("sess-pinned-permission", {
        sessionRoot: "/workspace/project",
      }),
    },
  });

  const { ws } = await openClient();
  try {
    const patched = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:main",
      permissionMode: "guarded",
    });

    expect(patched).toMatchObject({ ok: true });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      permissionMode: "guarded",
    });

    const cleared = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:main",
      permissionMode: null,
    });
    expect(cleared).toMatchObject({ ok: true });
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).not.toHaveProperty(
      "permissionMode",
    );

    const pinned = await rpcReq(ws, "sessions.patch", {
      key: pinnedSessionKey,
      permissionMode: "workspace",
    });
    expect(pinned).toMatchObject({ ok: true });
    expect(loadSessionEntry({ sessionKey: pinnedSessionKey, storePath })).toMatchObject({
      permissionMode: "workspace",
      sessionRoot: "/workspace/project",
    });
  } finally {
    ws.close();
  }
});

test("createGatewaySession stores a permission mode without a prepared session root", async () => {
  await createSessionStoreDir();
  const { createGatewaySession } = await import("./session-create-service.js");

  const created = await createGatewaySession({
    cfg: getRuntimeConfig(),
    agentId: "main",
    commandSource: "test",
    permissionMode: "guarded",
  });

  expect(created).toMatchObject({
    ok: true,
    entry: { permissionMode: "guarded" },
  });
  expect(created).not.toHaveProperty("entry.sessionRoot");
});

test("sessions.reset applies a rootless permission mode and interrupts admitted work", async () => {
  const { storePath } = await seedActiveMainSession();
  let interrupted = false;
  let releaseAdmission = () => {};
  const admissionLease = await beginSessionWorkAdmission({
    scope: storePath,
    identities: ["agent:main:main", "sess-main"],
    assertAllowed: () => {},
    onInterrupt: () => {
      interrupted = true;
      releaseAdmission();
    },
  });
  releaseAdmission = admissionLease.release;

  try {
    const { performGatewaySessionReset } = await import("./session-reset-service.js");
    const reset = await performGatewaySessionReset({
      key: "main",
      reason: "reset",
      commandSource: "gateway:agent",
      workerPlacementContext: {},
      permissionMode: "guarded",
    });

    expect(reset).toMatchObject({
      ok: true,
      entry: { permissionMode: "guarded" },
    });
    expect(interrupted).toBe(true);
    expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
      permissionMode: "guarded",
    });
  } finally {
    admissionLease.release();
  }
});

test("sessions.reset preserves a persisted rootless permission mode", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-legacy-rootless-permission", { permissionMode: "full" }),
    },
  });
  const { performGatewaySessionReset } = await import("./session-reset-service.js");

  const reset = await performGatewaySessionReset({
    key: "main",
    reason: "reset",
    commandSource: "gateway:agent",
    workerPlacementContext: {},
  });

  expect(reset).toMatchObject({
    ok: true,
    entry: { permissionMode: "full" },
  });
  if (reset.ok && "entry" in reset) {
    expect(reset.entry.sessionRoot).toBeUndefined();
  }
});

type SpeedFields = { fastMode?: boolean | string; effectiveFastMode?: boolean | string };

test("session wire speed negotiation preserves canonical ultrafast across legacy and current clients", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentConfig = { fastModeDefault: "ultrafast", model: "openai/gpt-test-a" };
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [{ id: "gpt-test-a", name: "Speed fixture", provider: "openai" }];
  await writeSessionStore({
    entries: { main: sessionStoreEntry("speed-session", { fastMode: "ultrafast" }) },
  });
  const legacy = await openClient({ caps: [] });
  const current = await openClient({ caps: ["ultrafast"] });
  const key = "agent:main:main";
  try {
    for (const [ws, expected] of [
      [legacy.ws, true],
      [current.ws, "ultrafast"],
    ] as const) {
      const list = await rpcReq<{ sessions: Array<SpeedFields & { key: string }> }>(
        ws,
        "sessions.list",
        {},
      );
      expect(list.ok).toBe(true);
      expect(list.payload?.sessions.find((row) => row.key === key)).toMatchObject({
        fastMode: expected,
        effectiveFastMode: expected,
      });
      const described = await rpcReq<{ session: SpeedFields }>(ws, "sessions.describe", { key });
      expect(described.ok).toBe(true);
      expect(described.payload?.session).toMatchObject({
        fastMode: expected,
        effectiveFastMode: expected,
      });
      for (const method of ["models.list", "chat.metadata"] as const) {
        const catalog = await rpcReq<{ models: SpeedFields[] }>(
          ws,
          method,
          method === "models.list" ? { preparedOnly: true } : { sessionKey: key },
        );
        expect(catalog.ok, JSON.stringify(catalog.error)).toBe(true);
        expect(catalog.payload?.models.length).toBeGreaterThan(0);
        expect(catalog.payload?.models.every((model) => model.effectiveFastMode === expected)).toBe(
          true,
        );
      }
      for (const method of ["chat.history", "chat.startup"] as const) {
        const history = await rpcReq<
          SpeedFields & { sessionInfo: SpeedFields; metadata?: { models?: SpeedFields[] } }
        >(ws, method, {
          sessionKey: key,
        });
        expect(history.ok, JSON.stringify(history.error)).toBe(true);
        expect(history.payload?.fastMode).toBe(expected);
        expect(history.payload?.sessionInfo).toMatchObject({
          fastMode: expected,
          effectiveFastMode: expected,
        });
      }
      const unsaved = await rpcReq<{ sessionInfo: SpeedFields }>(ws, "chat.history", {
        sessionKey: "agent:main:unsaved-speed",
      });
      expect(unsaved.ok, JSON.stringify(unsaved.error)).toBe(true);
      expect(unsaved.payload?.sessionInfo.effectiveFastMode).toBe(expected);
      const patch = await rpcReq<{ entry: SpeedFields }>(ws, "sessions.patch", {
        key,
        label: "Speed compatibility",
      });
      expect(patch.ok, JSON.stringify(patch.error)).toBe(true);
      expect(patch.payload?.entry.fastMode).toBe(expected);
      expect((await rpcReq(ws, "sessions.subscribe", {})).ok).toBe(true);
    }
    const changed = [legacy.ws, current.ws].map((ws) =>
      onceMessage(
        ws,
        (message) =>
          message.type === "event" &&
          message.event === "sessions.changed" &&
          message.payload?.reason === "patch",
      ),
    );
    expect(
      (await rpcReq(current.ws, "sessions.patch", { key, label: "Renamed speed session" })).ok,
    ).toBe(true);
    for (const [index, message] of (await Promise.all(changed)).entries()) {
      const expected = index === 0 ? true : "ultrafast";
      expect(message.payload).toMatchObject({
        fastMode: expected,
        effectiveFastMode: expected,
        session: { fastMode: expected, effectiveFastMode: expected },
      });
    }
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.fastMode).toBe(
      "ultrafast",
    );
    const createdKey = "agent:main:dashboard:speed-created";
    for (const [ws, expected] of [
      [current.ws, "ultrafast"],
      [legacy.ws, true],
      [current.ws, "ultrafast"],
    ] as const) {
      const created = await rpcReq<{ entry: SpeedFields }>(ws, "sessions.create", {
        agentId: "main",
        key: createdKey,
        fastMode: "ultrafast",
        idempotencyKey: "speed-create-once",
      });
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      expect(created.payload?.entry.fastMode).toBe(expected);
    }
    expect(loadSessionEntry({ agentId: "main", sessionKey: createdKey, storePath })?.fastMode).toBe(
      "ultrafast",
    );
    const reset = await rpcReq<{ entry: SpeedFields }>(legacy.ws, "sessions.reset", { key });
    expect(reset.ok, JSON.stringify(reset.error)).toBe(true);
    expect(reset.payload?.entry.fastMode).toBe(true);
    expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })?.fastMode).toBe(
      "ultrafast",
    );
  } finally {
    legacy.ws.close();
    current.ws.close();
  }
});
