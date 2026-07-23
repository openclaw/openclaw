/**
 * Live Gateway RPC proof that sessions.get caps oversized numeric limits.
 */
import { expect, test } from "vitest";
import { writeSessionStore, testState } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
  directSessionReq,
  seedLinearSessionTranscript,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

test("sessions.get caps oversized numeric limit over live Gateway RPC", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  try {
    const sessionId = "sess-get-limit-cap";
    const seeded = 1005;
    await writeSessionStore({
      storePath,
      entries: {
        main: sessionStoreEntry(sessionId),
      },
    });
    await seedLinearSessionTranscript({
      contents: Array.from({ length: seeded }, (_, index) => `msg-${index}`),
      sessionId,
      sessionKey: "main",
      storePath,
    });

    const result = await directSessionReq<{ messages?: unknown[] }>("sessions.get", {
      key: "main",
      limit: Number.MAX_SAFE_INTEGER,
    });

    expect(result.ok).toBe(true);
    expect(result.payload?.messages).toHaveLength(1000);
    const rendered = JSON.stringify(result.payload?.messages ?? []);
    expect(rendered).toContain("msg-1004");
    expect(rendered).not.toContain("msg-0");
  } finally {
    testState.sessionStorePath = undefined;
    void dir;
  }
});
