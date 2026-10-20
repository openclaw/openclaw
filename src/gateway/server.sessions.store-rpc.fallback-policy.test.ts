import { expect, test } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { agentDiscoveryMock, rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import { setupGatewaySessionsTestHarness } from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();
type SessionPatchResponse = { ok: true; key: string; entry: Record<string, unknown> };
test("session fallback opt-in survives RPC persistence and reset without changing defaults", async () => {
  const { storePath } = await createSessionStoreDir();
  const key = "agent:main:fallback-preference";
  testState.agentConfig = {
    model: { primary: "backup/default", fallbacks: ["backup/healthy"] },
    modelSelectionScope: "global",
  };
  const configBefore = structuredClone(testState.agentConfig);
  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [
    { id: "selected", name: "Preferred", provider: "preferred" },
    { id: "default", name: "Default", provider: "backup" },
  ];
  await writeSessionStore({
    entries: { [key]: { sessionId: "preference-rpc", updatedAt: Date.now() } },
  });
  const { ws } = await openClient();
  try {
    const selected = await rpcReq<SessionPatchResponse>(ws, "sessions.patch", {
      key,
      model: "preferred/selected",
      modelFallbackPolicy: "configured",
    });
    expect(selected.ok, JSON.stringify(selected)).toBe(true);
    const expected = {
      providerOverride: "preferred",
      modelOverride: "selected",
      modelOverrideSource: "user",
      modelFallbackPolicy: "configured",
    };
    expect(selected.payload?.entry).toMatchObject(expected);
    expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject(expected);
    const reset = await rpcReq<SessionPatchResponse>(ws, "sessions.reset", { key });
    expect(reset.ok, JSON.stringify(reset)).toBe(true);
    expect(loadSessionEntry({ sessionKey: key, storePath })).toMatchObject(expected);
    const cleared = await rpcReq<SessionPatchResponse>(ws, "sessions.patch", {
      key,
      modelFallbackPolicy: null,
    });
    expect(cleared.ok, JSON.stringify(cleared)).toBe(true);
    expect(loadSessionEntry({ sessionKey: key, storePath })?.modelFallbackPolicy).toBeUndefined();
    expect(loadSessionEntry({ sessionKey: key, storePath })?.modelOverride).toBe("selected");
    expect(testState.agentConfig).toEqual(configBefore);
  } finally {
    ws.close();
  }
});
