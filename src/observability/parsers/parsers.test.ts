import { describe, expect, it } from "vitest";
import { parseCacheTraceLine } from "./cache-trace.js";
import { parseSessionLine } from "./session.js";
import { parseSystemLogLine } from "./system-log.js";

describe("parsers", () => {
  describe("parseSystemLogLine", () => {
    it("parses tslog JSON format", () => {
      const line = JSON.stringify({
        _meta: {
          date: "2024-01-01T12:00:00.000Z",
          logLevelId: 3,
          logLevelName: "INFO",
          name: "gateway",
        },
        0: "Server started",
      });

      const result = parseSystemLogLine(line, "/tmp/openclaw/openclaw-2024-01-01.log");

      expect(result).not.toBeNull();
      expect(result?.ts).toBe("2024-01-01T12:00:00.000Z");
      expect(result?.sourceType).toBe("system-log");
      expect(result?.level).toBe("info");
      expect(result?.eventType).toBe("log:gateway");
      expect(result?.messagePreview).toBe("Server started");
    });

    it("returns null for non-JSON lines", () => {
      const result = parseSystemLogLine("not json", "/tmp/test.log");
      expect(result).toBeNull();
    });

    it("returns null for empty lines", () => {
      const result = parseSystemLogLine("", "/tmp/test.log");
      expect(result).toBeNull();
    });
  });

  describe("parseCacheTraceLine", () => {
    it("parses cache trace events", () => {
      const line = JSON.stringify({
        ts: "2024-01-01T12:00:00.000Z",
        seq: 1,
        stage: "session:loaded",
        runId: "run-123",
        sessionId: "session-456",
        provider: "anthropic",
        modelId: "claude-3",
        messageCount: 5,
      });

      const result = parseCacheTraceLine(line, "~/.openclaw/logs/cache-trace.jsonl");

      expect(result).not.toBeNull();
      expect(result?.ts).toBe("2024-01-01T12:00:00.000Z");
      expect(result?.sourceType).toBe("cache-trace");
      expect(result?.eventType).toBe("cache:session:loaded");
      expect(result?.runId).toBe("run-123");
      expect(result?.sessionId).toBe("session-456");
      expect(result?.provider).toBe("anthropic");
      expect(result?.modelId).toBe("claude-3");
      expect(result?.messagePreview).toBe("messages: 5");
    });

    it("handles error events", () => {
      const line = JSON.stringify({
        ts: "2024-01-01T12:00:00.000Z",
        seq: 1,
        stage: "session:loaded",
        error: "Something went wrong",
      });

      const result = parseCacheTraceLine(line, "test.jsonl");

      expect(result?.messagePreview).toBe("error: Something went wrong");
    });

    it("returns null for invalid cache trace events", () => {
      const line = JSON.stringify({ notACacheTrace: true });
      const result = parseCacheTraceLine(line, "test.jsonl");
      expect(result).toBeNull();
    });
  });

  describe("parseSessionLine", () => {
    it("parses session header", () => {
      const line = JSON.stringify({
        type: "session",
        version: 1,
        id: "session-123",
        timestamp: "2024-01-01T12:00:00.000Z",
        cwd: "/home/user",
      });

      const result = parseSessionLine(line, "~/.openclaw/agents/default/sessions/session.jsonl");

      expect(result).not.toBeNull();
      expect(result?.ts).toBe("2024-01-01T12:00:00.000Z");
      expect(result?.sourceType).toBe("session");
      expect(result?.eventType).toBe("session:start");
      expect(result?.sessionId).toBe("session-123");
      expect(result?.agentId).toBe("default");
    });

    it("parses session messages", () => {
      const line = JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "Hello, world!" }],
          provider: "anthropic",
          model: "claude-3",
          timestamp: 1704110400000,
        },
      });

      const result = parseSessionLine(line, "~/.openclaw/agents/myagent/sessions/test.jsonl");

      expect(result).not.toBeNull();
      expect(result?.sourceType).toBe("session");
      expect(result?.eventType).toBe("session:message:user");
      expect(result?.role).toBe("user");
      expect(result?.provider).toBe("anthropic");
      expect(result?.modelId).toBe("claude-3");
      expect(result?.messagePreview).toBe("Hello, world!");
      expect(result?.agentId).toBe("myagent");
    });

    it("extracts agent ID from path", () => {
      const line = JSON.stringify({
        type: "session",
        version: 1,
        id: "test",
        timestamp: "2024-01-01T12:00:00.000Z",
      });

      const result = parseSessionLine(
        line,
        "/home/user/.openclaw/agents/custom-agent/sessions/s.jsonl",
      );

      expect(result?.agentId).toBe("custom-agent");
    });

    it("returns null for invalid session entries", () => {
      const line = JSON.stringify({ notASession: true });
      const result = parseSessionLine(line, "test.jsonl");
      expect(result).toBeNull();
    });
  });
});
