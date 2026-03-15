import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emitHeartbeat,
  emitCheckpoint,
  emitTimeout,
  emitStalled,
  emitRecovered,
  extractErrorInfo,
  createLifecycleMetadata,
} from "./agent-lifecycle.js";

vi.mock("./agent-events.js", () => ({
  emitAgentEvent: vi.fn(),
}));

import { emitAgentEvent } from "./agent-events.js";

describe("agent-lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("createLifecycleMetadata", () => {
    it("creates metadata with required fields", () => {
      const metadata = createLifecycleMetadata({
        runId: "test-run-123",
        sessionKey: "session-abc",
        agentId: "agent-def",
        startedAt: 1000,
      });

      expect(metadata.runId).toBe("test-run-123");
      expect(metadata.sessionKey).toBe("session-abc");
      expect(metadata.agentId).toBe("agent-def");
      expect(metadata.startedAt).toBe(1000);
      expect(metadata.timestamp).toBeDefined();
      expect(typeof metadata.timestamp).toBe("number");
    });

    it("handles optional fields", () => {
      const metadata = createLifecycleMetadata({
        runId: "test-run-456",
      });

      expect(metadata.runId).toBe("test-run-456");
      expect(metadata.sessionKey).toBeUndefined();
      expect(metadata.agentId).toBeUndefined();
    });
  });

  describe("emitHeartbeat", () => {
    it("emits heartbeat event with correct phase", () => {
      const startedAt = Date.now() - 5000;

      emitHeartbeat({
        runId: "heartbeat-run-123",
        sessionKey: "session-abc",
        agentId: "agent-def",
        startedAt,
        checkpoint: "tool-execution",
      });

      expect(emitAgentEvent).toHaveBeenCalledWith({
        runId: "heartbeat-run-123",
        stream: "lifecycle",
        data: expect.objectContaining({
          phase: "heartbeat",
        }),
        sessionKey: "session-abc",
      });
    });

    it("emits heartbeat without optional checkpoint", () => {
      const startedAt = Date.now() - 3000;

      emitHeartbeat({
        runId: "heartbeat-run-456",
        startedAt,
      });

      expect(emitAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "heartbeat-run-456",
          stream: "lifecycle",
          data: expect.objectContaining({
            phase: "heartbeat",
          }),
        }),
      );
    });
  });

  describe("emitCheckpoint", () => {
    it("emits checkpoint event with progress", () => {
      const startedAt = Date.now() - 10000;

      emitCheckpoint({
        runId: "checkpoint-run-123",
        sessionKey: "session-xyz",
        startedAt,
        checkpoint: "compaction",
        progress: "30%",
      });

      expect(emitAgentEvent).toHaveBeenCalledWith({
        runId: "checkpoint-run-123",
        stream: "lifecycle",
        data: expect.objectContaining({
          phase: "checkpoint",
        }),
        sessionKey: "session-xyz",
      });
    });
  });

  describe("emitTimeout", () => {
    it("emits timeout event with error details", () => {
      const startedAt = Date.now() - 60000;

      emitTimeout({
        runId: "timeout-run-123",
        sessionKey: "session-timeout",
        startedAt,
        timeoutMs: 60000,
        lastCheckpoint: "tool-execution",
      });

      expect(emitAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "timeout-run-123",
          stream: "lifecycle",
          data: expect.objectContaining({
            phase: "timeout",
            error: expect.objectContaining({
              type: "TIMEOUT",
              message: expect.stringContaining("timed out"),
            }),
          }),
          sessionKey: "session-timeout",
        }),
      );
    });
  });

  describe("emitStalled", () => {
    it("emits stalled event when agent appears stuck", () => {
      const startedAt = Date.now() - 30000;

      emitStalled({
        runId: "stalled-run-123",
        sessionKey: "session-stalled",
        startedAt,
        stalledDurationMs: 20000,
        lastActivity: "waiting-for-tool",
      });

      expect(emitAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "stalled-run-123",
          stream: "lifecycle",
          data: expect.objectContaining({
            phase: "stalled",
            durationMs: 20000,
          }),
          sessionKey: "session-stalled",
        }),
      );
    });
  });

  describe("emitRecovered", () => {
    it("emits recovered event after stall", () => {
      const startedAt = Date.now() - 45000;
      const recoveredAt = Date.now();

      emitRecovered({
        runId: "recovered-run-123",
        sessionKey: "session-recovered",
        startedAt,
        recoveredAt,
        wasStalledForMs: 15000,
      });

      expect(emitAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "recovered-run-123",
          stream: "lifecycle",
          data: expect.objectContaining({
            phase: "recovered",
            durationMs: expect.any(Number),
          }),
          sessionKey: "session-recovered",
        }),
      );
    });
  });

  describe("extractErrorInfo", () => {
    it("extracts info from Error object", () => {
      const error = new Error("Something went wrong");
      const info = extractErrorInfo(error);

      expect(info.type).toBe("Error");
      expect(info.message).toBe("Something went wrong");
      expect(info.stack).toBeDefined();
    });

    it("handles non-Error objects", () => {
      const info = extractErrorInfo("string error");

      expect(info.type).toBe("UnknownError");
      expect(info.message).toBe("string error");
    });

    it("handles objects with name property", () => {
      const error = { name: "CustomError", message: "Custom message" };
      const info = extractErrorInfo(error);

      expect(info.type).toBe("CustomError");
      expect(info.message).toBe("Custom message");
    });
  });
});
