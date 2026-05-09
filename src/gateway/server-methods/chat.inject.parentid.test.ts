import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendSqliteSessionTranscriptEvent,
  loadSqliteSessionTranscriptEvents,
} from "../../config/sessions/transcript-store.sqlite.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { appendInjectedAssistantMessageToTranscript } from "./chat-transcript-inject.js";
import { createSqliteTranscriptFixtureSync } from "./chat.test-helpers.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

// Guardrail: Gateway-injected assistant transcript messages must attach to the
// current leaf with a `parentId` and must not sever compaction history.
describe("gateway chat.inject transcript writes", () => {
  it("appends a Pi session entry that includes parentId", async () => {
    const { dir, agentId, sessionId } = createSqliteTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-",
      sessionId: "sess-1",
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", dir);

    try {
      const appended = await appendInjectedAssistantMessageToTranscript({
        agentId,
        sessionId,
        message: "hello",
      });
      expect(appended.ok).toBe(true);
      expect(appended.messageId).toBeTypeOf("string");
      const messageId = appended.messageId;
      if (!messageId) {
        throw new Error("expected appended message id");
      }
      expect(messageId.length).toBeGreaterThan(0);

      const events = loadSqliteSessionTranscriptEvents({
        agentId: "main",
        sessionId,
      }).map((entry) => entry.event as Record<string, unknown>);
      const last = events.at(-1) as Record<string, unknown>;
      expect(last.type).toBe("message");

      expect(Object.prototype.hasOwnProperty.call(last, "parentId")).toBe(true);
      expect(last).toHaveProperty("id");
      expect(last).toHaveProperty("message");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("links injected messages after oversized SQLite transcript entries", async () => {
    const { dir, agentId, sessionId } = createSqliteTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-large-",
      sessionId: "sess-1",
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", dir);

    try {
      appendSqliteSessionTranscriptEvent({
        agentId: "main",
        sessionId,
        event: {
          type: "message",
          id: "legacy-large-message",
          parentId: null,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }],
          },
        },
      });

      const appended = await appendInjectedAssistantMessageToTranscript({
        agentId,
        sessionId,
        message: "hello",
      });
      expect(appended.ok).toBe(true);
      expect(appended.messageId).toBeTypeOf("string");
      const messageId = appended.messageId;
      if (!messageId) {
        throw new Error("expected appended message id");
      }
      expect(messageId.length).toBeGreaterThan(0);

      const events = loadSqliteSessionTranscriptEvents({
        agentId: "main",
        sessionId,
      }).map((entry) => entry.event as Record<string, unknown>);
      const last = events.at(-1) as Record<string, unknown>;

      expect(last.type).toBe("message");
      expect(last).toHaveProperty("id", messageId);
      expect(last).toHaveProperty("message");
      expect(last).toHaveProperty("parentId", "legacy-large-message");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mirrors injected assistant messages into SQLite when agent and session scope are known", async () => {
    const { dir, agentId } = createSqliteTranscriptFixtureSync({
      prefix: "openclaw-chat-inject-sqlite-",
      sessionId: "sess-1",
    });
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-chat-inject-state-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    try {
      const appended = await appendInjectedAssistantMessageToTranscript({
        agentId,
        sessionId: "sess-1",
        message: "sqlite hello",
      });
      expect(appended.ok).toBe(true);

      const events = loadSqliteSessionTranscriptEvents({
        env: { OPENCLAW_STATE_DIR: stateDir },
        agentId: "main",
        sessionId: "sess-1",
      });
      expect(events.map((entry) => entry.event)).toEqual([
        expect.objectContaining({
          type: "session",
          id: "sess-1",
        }),
        expect.objectContaining({
          type: "message",
          id: appended.messageId,
          message: expect.objectContaining({
            role: "assistant",
            model: "gateway-injected",
          }),
        }),
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
