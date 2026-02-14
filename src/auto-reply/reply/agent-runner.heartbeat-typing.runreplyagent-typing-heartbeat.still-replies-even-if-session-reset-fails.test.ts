import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as sessions from "../../config/sessions.js";
import {
  createMinimalRun,
  getRunEmbeddedPiAgentMock,
  installRunReplyAgentTypingHeartbeatTestHooks,
} from "./agent-runner.heartbeat-typing.test-harness.js";
const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();

describe("runReplyAgent typing (heartbeat)", () => {
  installRunReplyAgentTypingHeartbeatTestHooks();

  it("still replies even if session reset fails to persist", async () => {
    const prevStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-session-reset-fail-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    const saveSpy = vi.spyOn(sessions, "saveSessionStore").mockRejectedValueOnce(new Error("boom"));
    try {
      const sessionId = "session-corrupt";
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const sessionEntry = { sessionId, updatedAt: Date.now() };
      const sessionStore = { main: sessionEntry };

      const transcriptPath = sessions.resolveSessionTranscriptPath(sessionId);
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, "bad", "utf-8");

      runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
        throw new Error(
          "function call turn comes immediately after a user turn or after a function response turn",
        );
      });

      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });
      const res = await run();

      expect(res).toMatchObject({
        text: expect.stringContaining("Session history was corrupted"),
      });
      expect(sessionStore.main).toBeUndefined();
      await expect(fs.access(transcriptPath)).rejects.toThrow();
    } finally {
      saveSpy.mockRestore();
      if (prevStateDir) {
        process.env.OPENCLAW_STATE_DIR = prevStateDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });
  it("rewrites Bun socket errors into friendly text", async () => {
    runEmbeddedPiAgentMock.mockImplementationOnce(async () => ({
      payloads: [
        {
          text: "TypeError: The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
          isError: true,
        },
      ],
      meta: {},
    }));

    const { run } = createMinimalRun();
    const res = await run();
    const payloads = Array.isArray(res) ? res : res ? [res] : [];
    expect(payloads.length).toBe(1);
    expect(payloads[0]?.text).toContain("LLM connection failed");
    expect(payloads[0]?.text).toContain("socket connection was closed unexpectedly");
    expect(payloads[0]?.text).toContain("```");
  });
});
