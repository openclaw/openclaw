import { expect, test } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { rpcReq, writeSessionStore } from "./test-helpers.js";
import { setupGatewaySessionsTestHarness } from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();
const key = "agent:main:topic-a";

test("write-scoped operators return a chat to automatic account selection", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "topic-a": {
        sessionId: "sess-topic-a",
        updatedAt: Date.now(),
        providerOverride: "openai",
        modelOverride: "gpt-test-a",
        authProfileOverride: "openai:work",
        authProfileOverrideSource: "user",
      },
    },
  });
  const { ws } = await openClient({ scopes: ["operator.write"] });
  try {
    const combined = await rpcReq(ws, "sessions.patch", {
      key,
      model: "openai/gpt-test-a@openai:other",
      authProfile: null,
    });
    expect(combined.ok).toBe(false);
    expect(loadSessionEntry({ sessionKey: key, storePath })?.authProfileOverride).toBe(
      "openai:work",
    );

    const cleared = await rpcReq(ws, "sessions.patch", { key, authProfile: null });
    expect(cleared.ok, JSON.stringify(cleared)).toBe(true);
    const entry = loadSessionEntry({ sessionKey: key, storePath });
    expect(entry).toMatchObject({
      sessionId: "sess-topic-a",
      providerOverride: "openai",
      modelOverride: "gpt-test-a",
      liveModelSwitchPending: true,
    });
    expect(entry?.authProfileOverride).toBeUndefined();
    expect(entry?.authProfileOverrideSource).toBeUndefined();
  } finally {
    ws.close();
  }
});
