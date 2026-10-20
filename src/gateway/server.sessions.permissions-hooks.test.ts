import { assert, expect, test } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { getRuntimeConfig } from "../config/io.js";
import { listSessionEntriesCore, loadSessionEntry } from "../config/sessions/session-accessor.js";
import { beginSessionEffect } from "../sessions/session-controller.lifecycle.js";
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
const mainKey = "agent:main:main";
const groupKey = "agent:main:discord:group:dev";
type SpeedFields = { fastMode?: boolean | string; effectiveFastMode?: boolean | string };
type SpeedResponses = {
  "sessions.list": { sessions: Array<SpeedFields & { key: string }> };
  "sessions.describe": { session: SpeedFields };
  "sessions.patch": { entry: SpeedFields };
} & Record<"models.list" | "chat.metadata", { models: SpeedFields[] }> &
  Record<"chat.history" | "chat.startup", SpeedFields & { sessionInfo: SpeedFields }>;
async function rpcOk<T extends Record<string, unknown>>(
  ws: Parameters<typeof rpcReq>[0],
  method: string,
  params: object,
) {
  const result = await rpcReq<T>(ws, method, params);
  expect(result.ok, JSON.stringify(result.error)).toBe(true);
  return result.payload;
}
async function seedSessions(entries: Parameters<typeof writeSessionStore>[0]["entries"]) {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({ entries });
  return storePath;
}

async function resetSession(permissionMode?: "guarded") {
  const { performGatewaySessionReset } = await import("./session-reset-service.js");
  return performGatewaySessionReset({
    key: "main",
    reason: "reset",
    commandSource: "gateway:agent",
    workerPlacementContext: {},
    ...(permissionMode ? { permissionMode } : {}),
  });
}

test("webchat session mutations follow operator scope policy", async () => {
  const storePath = await seedSessions({
    [mainKey]: sessionStoreEntry("main-session"),
    [groupKey]: sessionStoreEntry("sess-group"),
  });

  const ws = await connectWebchatClient({
    port: getHarness().port,
    client: {
      id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
      mode: GATEWAY_CLIENT_MODES.UI,
      version: "1.0.0",
      platform: "test",
    },
    scopes: ["operator.read"],
  });

  const deniedMutations = [
    ["sessions.patch", { key: groupKey, label: "should-fail" }, "operator.write"],
    ["sessions.delete", { key: groupKey }, "operator.admin"],
    ["sessions.compact", { key: "main", maxLines: 3 }, "operator.admin"],
    ["sessions.branches.switch", { sessionKey: mainKey, leafEntryId: "entry-1" }, "operator.admin"],
    ["sessions.rewind", { sessionKey: mainKey, entryId: "entry-1" }, "operator.admin"],
    ["sessions.fork", { sessionKey: mainKey, entryId: "entry-1" }, "operator.write"],
    ["sessions.dispatch", { key: mainKey, profileId: "test" }, "operator.admin"],
    ["sessions.dispatch", { key: mainKey, deviceId: "device-1" }, "operator.write"],
    ["sessions.reclaim", { key: mainKey }, "operator.write"],
    [
      "sessions.move",
      {
        key: mainKey,
        expected: { generation: 1, environmentId: "environment-1", ownerEpoch: 1 },
        target: { kind: "gateway" },
      },
      "operator.write",
    ],
    [
      "sessions.pluginPatch",
      { key: mainKey, pluginId: "test-plugin", namespace: "test", value: true },
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
  ).toEqual([groupKey, mainKey]);

  expect(sessionHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  ws.close();
});

test("session:patch hook mutations cannot change the response path", async () => {
  await seedSessions({ main: sessionStoreEntry("sess-cfg-isolation-test") });

  sessionHookMocks.triggerInternalHook.mockImplementationOnce(async (event) => {
    assert(isInternalHookEvent(event));
    expect(event).toMatchObject({ type: "session", action: "patch" });
    assert(event.context.cfg && typeof event.context.cfg === "object");
    Object.assign(event.context.cfg, { agents: { defaults: { model: "zai/glm-4.6" } } });
  });

  const { ws } = await openClient();
  const resolved = {
    modelProvider: "anthropic",
    model: "claude-opus-4-6",
    agentRuntime: { id: "openclaw", source: "implicit" },
    runtimeSelectionLocked: false,
  };
  const patched = await rpcOk<{ entry: { label?: string }; resolved: typeof resolved }>(
    ws,
    "sessions.patch",
    { key: mainKey, label: "cfg-isolation" },
  );

  expect(sessionHookMocks.triggerInternalHook).toHaveBeenCalledOnce();
  expect(sessionHookMocks.triggerInternalHook.mock.calls[0]?.[0]).toMatchObject({
    type: "session",
    action: "patch",
    sessionKey: mainKey,
    context: {
      sessionEntry: { sessionId: "sess-cfg-isolation-test", label: "cfg-isolation" },
      patch: { label: "cfg-isolation" },
    },
  });
  expect(patched?.resolved).toEqual(resolved);
  expect(patched?.entry.label).toBe("cfg-isolation");

  ws.close();
});

test("sessions.patch stores and clears rootless modes while preserving recorded roots", async () => {
  const pinnedKey = "agent:main:dashboard:pinned-permission";
  const storePath = await seedSessions({
    main: sessionStoreEntry("sess-rootless-permission"),
    [pinnedKey]: sessionStoreEntry("sess-pinned-permission", {
      sessionRoot: "/workspace/project",
    }),
  });

  const { ws } = await openClient();
  const patchMode = (key: string, permissionMode: "guarded" | "workspace" | null) =>
    rpcOk(ws, "sessions.patch", { key, permissionMode });
  const stored = (sessionKey = mainKey) => loadSessionEntry({ sessionKey, storePath });
  try {
    await patchMode(mainKey, "guarded");
    expect(stored()).toMatchObject({ permissionMode: "guarded" });
    await patchMode(mainKey, null);
    expect(stored()).not.toHaveProperty("permissionMode");
    await patchMode(pinnedKey, "workspace");
    expect(stored(pinnedKey)).toMatchObject({
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

  expect(created).toMatchObject({ ok: true, entry: { permissionMode: "guarded" } });
  expect(created).not.toHaveProperty("entry.sessionRoot");
});

test("sessions.reset applies a rootless permission mode and interrupts admitted work", async () => {
  const { storePath } = await seedActiveMainSession();
  let interrupted = false;
  let releaseAdmission = () => {};
  const admissionLease = await beginSessionEffect({
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
    expect(await resetSession("guarded")).toMatchObject({
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
  await seedSessions({
    main: sessionStoreEntry("sess-legacy-rootless-permission", { permissionMode: "full" }),
  });
  const reset = await resetSession();
  expect(reset).toMatchObject({ ok: true, entry: { permissionMode: "full" } });
  if (reset.ok && "entry" in reset) {
    expect(reset.entry.sessionRoot).toBeUndefined();
  }
});

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
  const key = mainKey;
  const storedMode = (sessionKey: string) =>
    loadSessionEntry({ agentId: "main", sessionKey, storePath })?.fastMode;
  try {
    for (const [ws, expected] of [
      [legacy.ws, true],
      [current.ws, "ultrafast"],
    ] as const) {
      const speed = { fastMode: expected, effectiveFastMode: expected };
      const request = <M extends keyof SpeedResponses>(method: M, params: object = {}) =>
        rpcOk<SpeedResponses[M]>(ws, method, params);
      const list = await request("sessions.list");
      expect(list?.sessions.find((row) => row.key === key)).toMatchObject(speed);
      const described = await request("sessions.describe", { key });
      expect(described?.session).toMatchObject(speed);
      for (const method of ["models.list", "chat.metadata"] as const) {
        const catalog = await request(
          method,
          method === "models.list" ? { preparedOnly: true } : { sessionKey: key },
        );
        expect(catalog?.models.length).toBeGreaterThan(0);
        expect(catalog?.models.every((model) => model.effectiveFastMode === expected)).toBe(true);
      }
      for (const method of ["chat.history", "chat.startup"] as const) {
        const history = await request(method, { sessionKey: key });
        expect(history).toMatchObject({ fastMode: expected, sessionInfo: speed });
      }
      const unsaved = await request("chat.history", {
        sessionKey: "agent:main:unsaved-speed",
      });
      expect(unsaved?.sessionInfo.effectiveFastMode).toBe(expected);
      const patch = await request("sessions.patch", { key, label: "Speed compatibility" });
      expect(patch?.entry.fastMode).toBe(expected);
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
    expect(storedMode(key)).toBe("ultrafast");
    const createdKey = "agent:main:dashboard:speed-created";
    for (const [ws, expected] of [
      [current.ws, "ultrafast"],
      [legacy.ws, true],
      [current.ws, "ultrafast"],
    ] as const) {
      const created = await rpcOk<{ entry: SpeedFields }>(ws, "sessions.create", {
        agentId: "main",
        key: createdKey,
        fastMode: "ultrafast",
        idempotencyKey: "speed-create-once",
      });
      expect(created?.entry.fastMode).toBe(expected);
    }
    expect(storedMode(createdKey)).toBe("ultrafast");
    const reset = await rpcOk<{ entry: SpeedFields }>(legacy.ws, "sessions.reset", { key });
    expect(reset?.entry.fastMode).toBe(true);
    expect(storedMode(key)).toBe("ultrafast");
  } finally {
    legacy.ws.close();
    current.ws.close();
  }
});
