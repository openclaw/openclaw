// Session permissions and hooks tests protect gateway access control around
// patch/delete/compact/fork APIs plus emitted internal hook payloads.
import { expect, test } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import {
  listSessionEntriesCore,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { isSessionPatchEvent } from "../hooks/internal-hooks.js";
import { connectWebchatClient, rpcReq, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionHookMocks,
  sessionStoreEntry,
  isInternalHookEvent,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient, getHarness } = setupGatewaySessionsTestHarness();
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

test("admin-scoped webchat client can mutate sessions", async () => {
  const { storePath } = await createPermissionSessionStore();
  const ws = await openPermissionClient({
    id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
    mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    scopes: ["operator.admin"],
  });

  const deleted = await rpcReq<{ ok: true; deleted: boolean }>(ws, "sessions.delete", {
    key: "agent:main:discord:group:dev",
  });
  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);

  expect(
    loadSessionEntry({ sessionKey: "agent:main:discord:group:dev", storePath }),
  ).toBeUndefined();

  ws.close();
});
