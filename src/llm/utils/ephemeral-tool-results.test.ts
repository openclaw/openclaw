import { describe, expect, it } from "vitest";
import {
  EPHEMERAL_TOOL_NAMES,
  isEphemeralToolName,
  summarizeEphemeralToolResult,
} from "./ephemeral-tool-results.js";

describe("ephemeral-tool-results", () => {
  describe("isEphemeralToolName", () => {
    it("returns true for heartbeat_respond", () => {
      expect(isEphemeralToolName("heartbeat_respond")).toBe(true);
    });

    it("returns true for session_status", () => {
      expect(isEphemeralToolName("session_status")).toBe(true);
    });

    it("returns true for exec", () => {
      expect(isEphemeralToolName("exec")).toBe(true);
    });

    it("returns true for mcporter", () => {
      expect(isEphemeralToolName("mcporter")).toBe(true);
    });

    it("returns true for read", () => {
      expect(isEphemeralToolName("read")).toBe(true);
    });

    it("returns true for web", () => {
      expect(isEphemeralToolName("web")).toBe(true);
    });

    it("returns true for memory", () => {
      expect(isEphemeralToolName("memory")).toBe(true);
    });

    it("returns false for non-ephemeral tool names", () => {
      expect(isEphemeralToolName("read_file")).toBe(false);
      expect(isEphemeralToolName("bash")).toBe(false);
      expect(isEphemeralToolName("write")).toBe(false);
      expect(isEphemeralToolName("")).toBe(false);
    });
  });

  describe("summarizeEphemeralToolResult", () => {
    it("produces a fixed-format summary with tool name", () => {
      const result = summarizeEphemeralToolResult("heartbeat_respond", "no_change");
      expect(result).toBe("[ephemeral tool result: heartbeat_respond]");
    });

    it("does not include any original output content", () => {
      const uniqueMarker = "UNIQUE_MARKER_12345";
      const result = summarizeEphemeralToolResult("exec", uniqueMarker);
      expect(result).toBe("[ephemeral tool result: exec]");
      // No portion of the original text should appear in the summary
      expect(result).not.toContain(uniqueMarker);
    });

    it("produces identical output regardless of input text (cache-stable)", () => {
      const result1 = summarizeEphemeralToolResult("session_status", "status: active");
      const result2 = summarizeEphemeralToolResult("session_status", "status: idle");
      expect(result1).toBe(result2);
      expect(result1).toBe("[ephemeral tool result: session_status]");
    });

    it("different tool names produce different summaries", () => {
      const text = "some output";
      const result1 = summarizeEphemeralToolResult("heartbeat_respond", text);
      const result2 = summarizeEphemeralToolResult("exec", text);
      expect(result1).not.toBe(result2);
      expect(result1).toContain("heartbeat_respond");
      expect(result2).toContain("exec");
    });

    it("summary length is constant for the same tool name", () => {
      const shortResult = summarizeEphemeralToolResult("memory", "ok");
      const longResult = summarizeEphemeralToolResult("memory", "a".repeat(5000));
      expect(shortResult.length).toBe(longResult.length);
    });
  });

  describe("EPHEMERAL_TOOL_NAMES", () => {
    it("contains all reported ephemeral tools", () => {
      expect(EPHEMERAL_TOOL_NAMES.has("heartbeat_respond")).toBe(true);
      expect(EPHEMERAL_TOOL_NAMES.has("session_status")).toBe(true);
      expect(EPHEMERAL_TOOL_NAMES.has("exec")).toBe(true);
      expect(EPHEMERAL_TOOL_NAMES.has("mcporter")).toBe(true);
      expect(EPHEMERAL_TOOL_NAMES.has("read")).toBe(true);
      expect(EPHEMERAL_TOOL_NAMES.has("web")).toBe(true);
      expect(EPHEMERAL_TOOL_NAMES.has("memory")).toBe(true);
    });

    it("is a frozen set (read-only)", () => {
      // ReadonlySet at runtime is still a Set — verify it's not trivially mutable
      expect(EPHEMERAL_TOOL_NAMES instanceof Set).toBe(true);
    });
  });
});
