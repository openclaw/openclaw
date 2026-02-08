/**
 * Tests for deterministic tracing.
 *
 * Tests cover:
 * - State hashing (deterministic, consistent)
 * - Trace writing (optional, append-only)
 * - Trace schema (versioning, serialization)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { loadTrace, serializeTrace } from "./tracing/schema.js";
import { hashAgentState, hashAndDescribe } from "./tracing/state-hash.js";
import { TraceWriter, NoOpTraceWriter, createTraceWriterIfEnabled } from "./tracing/writer.js";

describe("tracing (phase 1: recording)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "trace-test-"));
  });

  describe("state hashing", () => {
    it("produces consistent hashes for identical state", () => {
      const state = { count: 1, name: "test", items: ["a", "b"] };
      const hash1 = hashAgentState(state);
      const hash2 = hashAgentState(state);
      expect(hash1).toBe(hash2);
    });

    it("produces different hashes for different state", () => {
      const state1 = { count: 1 };
      const state2 = { count: 2 };
      const hash1 = hashAgentState(state1);
      const hash2 = hashAgentState(state2);
      expect(hash1).not.toBe(hash2);
    });

    it("handles nested objects with key sorting", () => {
      const state1 = { z: 1, a: 2 };
      const state2 = { a: 2, z: 1 };
      const hash1 = hashAgentState(state1);
      const hash2 = hashAgentState(state2);
      expect(hash1).toBe(hash2);
    });

    it("distinguishes between null and undefined", () => {
      const state1 = { value: null };
      const state2 = { value: undefined };
      const hash1 = hashAgentState(state1);
      const hash2 = hashAgentState(state2);
      expect(hash1).not.toBe(hash2);
    });

    it("throws on unhashable types", () => {
      expect(() => {
        hashAgentState({ fn: () => {} });
      }).toThrow("Cannot hash value of type function");

      expect(() => {
        hashAgentState({ sym: Symbol("x") });
      }).toThrow("Cannot hash value of type symbol");

      expect(() => {
        hashAgentState({ num: Number.NaN });
      }).toThrow("Cannot hash non-finite number");
    });

    it("returns both hash and canonical form", () => {
      const state = { a: 1, b: 2 };
      const result = hashAndDescribe(state);
      expect(result.hash).toBeDefined();
      expect(result.canonical).toBeDefined();
      expect(result.hash).toMatch(/^[a-f0-9]{64}$/); // SHA-256 hex
    });
  });

  describe("trace writer", () => {
    it("initializes trace file", async () => {
      const tracePath = path.join(tmpDir, "trace.json");
      const writer = new TraceWriter(tracePath, "test-session", "test:key", "run-123", "Hello");
      await writer.initialize();

      expect(fs.existsSync(tracePath)).toBe(true);
      const content = fs.readFileSync(tracePath, "utf-8");
      const trace = loadTrace(content);
      expect(trace.metadata.sessionId).toBe("test-session");
      expect(trace.metadata.runId).toBe("run-123");
      expect(trace.entries).toHaveLength(0);
    });

    it("records LLM calls", async () => {
      const tracePath = path.join(tmpDir, "trace.json");
      const writer = new TraceWriter(tracePath, "test-session", undefined, "run-123", "Hello");
      await writer.initialize();

      writer.recordLlmCall({
        messages: [{ role: "user", content: "Hi" }],
        response: "Hello there",
        model: { provider: "anthropic", modelId: "claude-3.5-sonnet" },
        tokenUsage: { inputTokens: 10, outputTokens: 5 },
        stateHash: "abc123",
      });

      await writer.flush();

      const content = fs.readFileSync(tracePath, "utf-8");
      const trace = loadTrace(content);
      expect(trace.entries).toHaveLength(1);
      const entry = trace.entries[0];
      expect(entry.type).toBe("llm_call");
      expect((entry as any).response).toBe("Hello there");
      expect((entry as any).stateHash).toBe("abc123");
    });

    it("records tool calls", async () => {
      const tracePath = path.join(tmpDir, "trace.json");
      const writer = new TraceWriter(tracePath, "session", undefined, "run-1", "");
      await writer.initialize();

      writer.recordToolCall({
        toolName: "exec",
        params: { command: "ls" },
        result: { success: true, output: "file.txt\n" },
        stateHash: "def456",
      });

      await writer.flush();

      const content = fs.readFileSync(tracePath, "utf-8");
      const trace = loadTrace(content);
      expect(trace.entries).toHaveLength(1);
      const entry = trace.entries[0];
      expect(entry.type).toBe("tool_call");
      expect((entry as any).toolName).toBe("exec");
      expect((entry as any).result.success).toBe(true);
    });

    it("records run completion", async () => {
      const tracePath = path.join(tmpDir, "trace.json");
      const writer = new TraceWriter(tracePath, "session", undefined, "run-1", "");
      await writer.initialize();

      writer.recordEnd({
        durationMs: 1234,
        outcome: "completed",
      });

      await writer.flush();

      const content = fs.readFileSync(tracePath, "utf-8");
      const trace = loadTrace(content);
      expect(trace.metadata.durationMs).toBe(1234);
      expect(trace.metadata.outcome).toBe("completed");
      expect(trace.metadata.error).toBeUndefined();
    });

    it("factory returns null when tracing disabled", async () => {
      const writer = await createTraceWriterIfEnabled({
        tracePath: undefined,
        sessionId: "session",
        runId: "run",
        initialPrompt: "",
      });
      expect(writer).toBeNull();
    });

    it("factory creates writer when enabled", async () => {
      const tracePath = path.join(tmpDir, "trace.json");
      const writer = await createTraceWriterIfEnabled({
        tracePath,
        sessionId: "session",
        runId: "run",
        initialPrompt: "test prompt",
      });
      expect(writer).not.toBeNull();
      expect(fs.existsSync(tracePath)).toBe(true);
    });

    it("supports multiple entries in append-only mode", async () => {
      const tracePath = path.join(tmpDir, "trace.json");
      const writer = new TraceWriter(tracePath, "session", undefined, "run", "prompt");
      await writer.initialize();

      // Record multiple entries
      writer.recordLlmCall({
        messages: [],
        response: "resp1",
        model: { provider: "test", modelId: "test" },
        stateHash: "hash1",
      });
      await writer.flush();

      writer.recordToolCall({
        toolName: "tool1",
        params: {},
        result: { success: true },
        stateHash: "hash2",
      });
      await writer.flush();

      writer.recordEnd({ durationMs: 100, outcome: "completed" });
      await writer.flush();

      const content = fs.readFileSync(tracePath, "utf-8");
      const trace = loadTrace(content);
      expect(trace.entries).toHaveLength(2);
      expect(trace.metadata.durationMs).toBe(100);
    });
  });

  describe("no-op trace writer", () => {
    it("implements interface but does nothing", () => {
      const writer = new NoOpTraceWriter();
      expect(() => {
        writer.recordLlmCall({
          messages: [],
          response: "",
          model: { provider: "test", modelId: "test" },
          stateHash: "",
        });
        writer.recordToolCall({
          toolName: "test",
          params: {},
          result: { success: true },
          stateHash: "",
        });
        writer.recordEnd({ durationMs: 0, outcome: "completed" });
      }).not.toThrow();
    });
  });

  describe("trace schema", () => {
    it("loads valid trace", () => {
      const json = JSON.stringify({
        traceVersion: 1,
        metadata: {
          createdAt: 0,
          sessionId: "test",
          runId: "run",
          initialPrompt: "",
          durationMs: 0,
          outcome: "completed" as const,
        },
        entries: [],
      });

      const trace = loadTrace(json);
      expect(trace.metadata.sessionId).toBe("test");
      expect(trace.traceVersion).toBe(1);
    });

    it("rejects invalid trace version", () => {
      const json = JSON.stringify({
        traceVersion: 2,
        metadata: {},
        entries: [],
      });

      expect(() => loadTrace(json)).toThrow("traceVersion");
    });

    it("serializes trace", () => {
      const trace = {
        traceVersion: 1 as const,
        metadata: {
          createdAt: 123,
          sessionId: "test",
          runId: "run",
          initialPrompt: "prompt",
          durationMs: 100,
          outcome: "completed" as const,
        },
        entries: [],
      };

      const json = serializeTrace(trace);
      expect(json).toContain("traceVersion");
      expect(json).toContain("test");
      const parsed = JSON.parse(json);
      expect(parsed.metadata.sessionId).toBe("test");
    });
  });
});
