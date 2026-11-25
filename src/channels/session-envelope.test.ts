import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { resolveInboundSessionEnvelopeContext } from "./session-envelope.js";

describe("resolveInboundSessionEnvelopeContext", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-session-envelope-");

  it("reads the previous timestamp from SQLite without a sessions.json file", async () => {
    const storePath = path.join(sessionDirs.make(), "sessions.json");
    const sessionKey = "agent:main:telegram:dm:1";
    await replaceSessionEntry(
      { agentId: "main", sessionKey, storePath },
      { sessionId: "session-1", updatedAt: 42 },
    );

    expect(
      resolveInboundSessionEnvelopeContext({
        cfg: { session: { store: storePath } },
        agentId: "main",
        sessionKey,
      }),
    ).toMatchObject({ storePath, previousTimestamp: 42 });
  });
});
