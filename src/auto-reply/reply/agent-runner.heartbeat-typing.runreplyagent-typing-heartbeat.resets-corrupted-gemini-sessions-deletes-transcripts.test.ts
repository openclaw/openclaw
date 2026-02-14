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

  it("resets corrupted Gemini sessions and deletes transcripts", async () => {
    const prevStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-session-reset-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const sessionId = "session-corrupt";
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const sessionEntry = { sessionId, updatedAt: Date.now() };
      const sessionStore = { main: sessionEntry };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(sessionStore), "utf-8");

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

      const persisted = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(persisted.main).toBeUndefined();
    } finally {
      if (prevStateDir) {
        process.env.OPENCLAW_STATE_DIR = prevStateDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });
  it("keeps sessions intact on other errors", async () => {
    const prevStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-session-noreset-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const sessionId = "session-ok";
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const sessionEntry = { sessionId, updatedAt: Date.now() };
      const sessionStore = { main: sessionEntry };

      await fs.mkdir(path.dirname(storePath), { recursive: true });
      await fs.writeFile(storePath, JSON.stringify(sessionStore), "utf-8");

      const transcriptPath = sessions.resolveSessionTranscriptPath(sessionId);
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, "ok", "utf-8");

      runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
        throw new Error("INVALID_ARGUMENT: some other failure");
      });

      const { run } = createMinimalRun({
        sessionEntry,
        sessionStore,
        sessionKey: "main",
        storePath,
      });
      const res = await run();

      expect(res).toMatchObject({
        text: expect.stringContaining("Agent failed before reply"),
      });
      expect(sessionStore.main).toBeDefined();
      await expect(fs.access(transcriptPath)).resolves.toBeUndefined();

      const persisted = JSON.parse(await fs.readFile(storePath, "utf-8"));
      expect(persisted.main).toBeDefined();
    } finally {
      if (prevStateDir) {
        process.env.OPENCLAW_STATE_DIR = prevStateDir;
      } else {
        delete process.env.OPENCLAW_STATE_DIR;
      }
    }
  });
  it("returns friendly message for role ordering errors thrown as exceptions", async () => {
    runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
      throw new Error("400 Incorrect role information");
    });

    const { run } = createMinimalRun({});
    const res = await run();

    expect(res).toMatchObject({
      text: expect.stringContaining("Message ordering conflict"),
    });
    expect(res).toMatchObject({
      text: expect.not.stringContaining("400"),
    });
  });
  it("returns friendly message for 'roles must alternate' errors thrown as exceptions", async () => {
    runEmbeddedPiAgentMock.mockImplementationOnce(async () => {
      throw new Error('messages: roles must alternate between "user" and "assistant"');
    });

    const { run } = createMinimalRun({});
    const res = await run();

    expect(res).toMatchObject({
      text: expect.stringContaining("Message ordering conflict"),
    });
  });
});
