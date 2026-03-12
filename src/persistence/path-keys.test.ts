import { describe, expect, it } from "vitest";
import {
  deriveSessionIdFromTranscriptPath,
  inferAgentIdFromAgentPath,
  normalizeMemoryDocumentPath,
  resolvePathRelativeToRoot,
} from "./path-keys.js";

describe("persistence path keys", () => {
  it("infers agent ids from agent-scoped paths", () => {
    expect(inferAgentIdFromAgentPath("/tmp/.openclaw/agents/main/sessions/sessions.json")).toBe(
      "main",
    );
    expect(inferAgentIdFromAgentPath("/tmp/no-agent-here")).toBeUndefined();
  });

  it("normalizes supported memory document paths", () => {
    expect(normalizeMemoryDocumentPath("MEMORY.md")).toBe("MEMORY.md");
    expect(normalizeMemoryDocumentPath("memory/2026-03-11.md")).toBe("memory/2026-03-11.md");
    expect(normalizeMemoryDocumentPath("notes/todo.md")).toBeUndefined();
  });

  it("resolves paths relative to a root", () => {
    expect(resolvePathRelativeToRoot("/tmp/workspace", "/tmp/workspace/memory/today.md")).toBe(
      "memory/today.md",
    );
    expect(resolvePathRelativeToRoot("/tmp/workspace", "/tmp/elsewhere/today.md")).toBeUndefined();
  });

  it("derives session ids from transcript paths", () => {
    expect(deriveSessionIdFromTranscriptPath("/tmp/sessions/abc123.jsonl")).toBe("abc123");
    expect(deriveSessionIdFromTranscriptPath("/tmp/sessions/abc123-topic-42.jsonl")).toBe("abc123");
  });
});
