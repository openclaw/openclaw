import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as sessions from "../../config/sessions.js";
import {
  createMinimalRun,
  getRunEmbeddedPiAgentMock,
  installRunReplyAgentTypingHeartbeatTestHooks,
} from "./agent-runner.heartbeat-typing.test-harness.js";
const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();

describe("runReplyAgent typing (heartbeat)", () => {
  installRunReplyAgentTypingHeartbeatTestHooks();

  it("retries after compaction failure by resetting the session", async () => {
    const prevStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-session-compaction-reset-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const sessionId = "session";
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const transcriptPath = sessions.resolveSessionTranscriptPath(sessionId);
      const sessionEntry = { sessionId, updatedAt: Date.now(), sessionFile: transcriptPath };
      const sessionStore = { main: sessionEntry };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(sessionStore), "utf-8");
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, "ok", "utf-8");

      runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
        throw new Error(
          'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
        );
      });

      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });
      const res = await run();

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const payload = Array.isArray(res) ? res[0] : res;
      expect(payload).toMatchObject({
        text: expect.stringContaining("Context limit exceeded during compaction"),
      });
      expect(payload.text?.toLowerCase()).toContain("reset");
      expect(sessionStore.main.sessionId).not.toBe(sessionId);

      const persisted = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(persisted.main.sessionId).toBe(sessionStore.main.sessionId);
    } finally {
      if (prevStateDir) {
        process.env.OPENCLAW_STATE_DIR = prevStateDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });

  it("retries after context overflow payload by resetting the session", async () => {
    const prevStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-session-overflow-reset-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const sessionId = "session";
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const transcriptPath = sessions.resolveSessionTranscriptPath(sessionId);
      const sessionEntry = { sessionId, updatedAt: Date.now(), sessionFile: transcriptPath };
      const sessionStore = { main: sessionEntry };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(sessionStore), "utf-8");
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, "ok", "utf-8");

      runEmbeddedPiAgentMock.mockImplementationOnce(async () => ({
        payloads: [{ text: "Context overflow: prompt too large", isError: true }],
        meta: {
          durationMs: 1,
          error: {
            kind: "context_overflow",
            message: 'Context overflow: Summarization failed: 400 {"message":"prompt is too long"}',
          },
        },
      }));

      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });
      const res = await run();

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const payload = Array.isArray(res) ? res[0] : res;
      expect(payload).toMatchObject({
        text: expect.stringContaining("Context limit exceeded"),
      });
      expect(payload.text?.toLowerCase()).toContain("reset");
      expect(sessionStore.main.sessionId).not.toBe(sessionId);

      const persisted = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(persisted.main.sessionId).toBe(sessionStore.main.sessionId);
    } finally {
      if (prevStateDir) {
        process.env.OPENCLAW_STATE_DIR = prevStateDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });

  it("resets the session after role ordering payloads", async () => {
    const prevStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-session-role-ordering-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const sessionId = "session";
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const transcriptPath = sessions.resolveSessionTranscriptPath(sessionId);
      const sessionEntry = { sessionId, updatedAt: Date.now(), sessionFile: transcriptPath };
      const sessionStore = { main: sessionEntry };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(sessionStore), "utf-8");
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, "ok", "utf-8");

      runEmbeddedPiAgentMock.mockImplementationOnce(async () => ({
        payloads: [{ text: "Message ordering conflict - please try again.", isError: true }],
        meta: {
          durationMs: 1,
          error: {
            kind: "role_ordering",
            message: 'messages: roles must alternate between "user" and "assistant"',
          },
        },
      }));

      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });
      const res = await run();

      const payload = Array.isArray(res) ? res[0] : res;
      expect(payload).toMatchObject({
        text: expect.stringContaining("Message ordering conflict"),
      });
      expect(payload.text?.toLowerCase()).toContain("reset");
      expect(sessionStore.main.sessionId).not.toBe(sessionId);
      await expect(fs.access(transcriptPath)).rejects.toBeDefined();

      const persisted = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(persisted.main.sessionId).toBe(sessionStore.main.sessionId);
    } finally {
      if (prevStateDir) {
        process.env.OPENCLAW_STATE_DIR = prevStateDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });
});
