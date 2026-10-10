import { expect, test } from "vitest";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { rpcReq, writeSessionStore } from "./test-helpers.js";
import {
  getGatewayConfigModule,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();
type SessionPatchResponse = { ok: true; key: string; entry: Record<string, unknown> };

test("write-scoped operators change and reset effort in an existing session", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { "topic-a": { sessionId: "sess-topic-a", updatedAt: Date.now() } },
  });
  const { getRuntimeConfig, writeConfigFile } = await getGatewayConfigModule();
  // Configured models remain available when discovery runs in the catalog worker.
  await writeConfigFile({
    ...getRuntimeConfig(),
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          baseUrl: "https://openai.invalid/v1",
          agentRuntime: { id: "openclaw" },
          models: [
            {
              id: "gpt-test-a",
              name: "A",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32768,
              maxTokens: 2048,
            },
          ],
        },
      },
    },
  });
  const { ws } = await openClient({ scopes: ["operator.write"] });
  try {
    const model = await rpcReq<SessionPatchResponse>(ws, "sessions.patch", {
      key: "agent:main:topic-a",
      model: "openai/gpt-test-a",
    });
    expect(model.ok, JSON.stringify(model)).toBe(true);
    // Use the same existing session after the accepted model switch: effort
    // writes must not require a new session or a stronger operator credential.
    for (const patch of [
      { thinkingLevel: "high" },
      { fastMode: true },
      { thinkingLevel: "off", fastMode: false },
      { thinkingLevel: "low", fastMode: "auto" },
    ]) {
      const changed = await rpcReq<SessionPatchResponse>(ws, "sessions.patch", {
        key: "agent:main:topic-a",
        ...patch,
      });
      expect(changed.ok, JSON.stringify(changed)).toBe(true);
      expect(changed.payload?.entry).toMatchObject(patch);
      expect(loadSessionEntry({ sessionKey: "agent:main:topic-a", storePath })).toMatchObject({
        sessionId: "sess-topic-a",
        ...patch,
      });
    }
    const cleared = await rpcReq<SessionPatchResponse>(ws, "sessions.patch", {
      key: "agent:main:topic-a",
      thinkingLevel: null,
      fastMode: null,
    });
    expect(cleared.ok, JSON.stringify(cleared)).toBe(true);
    const clearedEntry = loadSessionEntry({ sessionKey: "agent:main:topic-a", storePath });
    expect(clearedEntry?.thinkingLevel).toBeUndefined();
    expect(clearedEntry?.fastMode).toBeUndefined();
  } finally {
    ws.close();
  }
});
