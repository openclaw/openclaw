import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionEntry,
  isIndexableSessionTranscriptFileName,
  listSessionFilesForAgent,
} from "./session-files.js";

describe("buildSessionEntry", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-entry-test-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns lineMap tracking original JSONL line numbers", async () => {
    // Simulate a real session JSONL file with metadata records interspersed
    // Lines 1-3: non-message metadata records
    // Line 4: user message
    // Line 5: metadata
    // Line 6: assistant message
    // Line 7: user message
    const jsonlLines = [
      JSON.stringify({ type: "custom", customType: "model-snapshot", data: {} }),
      JSON.stringify({ type: "custom", customType: "openclaw.cache-ttl", data: {} }),
      JSON.stringify({ type: "session-meta", agentId: "test" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Hello world" } }),
      JSON.stringify({ type: "custom", customType: "tool-result", data: {} }),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "Hi there, how can I help?" },
      }),
      JSON.stringify({ type: "message", message: { role: "user", content: "Tell me a joke" } }),
    ];
    const filePath = path.join(tmpDir, "session.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();

    // The content should have 3 lines (3 message records)
    const contentLines = entry!.content.split("\n");
    expect(contentLines).toHaveLength(3);
    expect(contentLines[0]).toContain("User: Hello world");
    expect(contentLines[1]).toContain("Assistant: Hi there");
    expect(contentLines[2]).toContain("User: Tell me a joke");

    // lineMap should map each content line to its original JSONL line (1-indexed)
    // Content line 0 → JSONL line 4 (the first user message)
    // Content line 1 → JSONL line 6 (the assistant message)
    // Content line 2 → JSONL line 7 (the second user message)
    expect(entry!.lineMap).toBeDefined();
    expect(entry!.lineMap).toEqual([4, 6, 7]);
  });

  it("returns empty lineMap when no messages are found", async () => {
    const jsonlLines = [
      JSON.stringify({ type: "custom", customType: "model-snapshot", data: {} }),
      JSON.stringify({ type: "session-meta", agentId: "test" }),
    ];
    const filePath = path.join(tmpDir, "empty-session.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe("");
    expect(entry!.lineMap).toEqual([]);
  });

  it("skips blank lines and invalid JSON without breaking lineMap", async () => {
    const jsonlLines = [
      "",
      "not valid json",
      JSON.stringify({ type: "message", message: { role: "user", content: "First" } }),
      "",
      JSON.stringify({ type: "message", message: { role: "assistant", content: "Second" } }),
    ];
    const filePath = path.join(tmpDir, "gaps.jsonl");
    await fs.writeFile(filePath, jsonlLines.join("\n"));

    const entry = await buildSessionEntry(filePath);
    expect(entry).not.toBeNull();
    expect(entry!.lineMap).toEqual([3, 5]);
  });

  it("identifies indexable transcript file names", () => {
    expect(isIndexableSessionTranscriptFileName("abc.jsonl")).toBe(true);
    expect(isIndexableSessionTranscriptFileName("abc.jsonl.reset.2026-02-14T19-44-05.473Z")).toBe(
      true,
    );
    expect(isIndexableSessionTranscriptFileName("abc.jsonl.deleted.2026-02-16T10-46-16.541Z")).toBe(
      true,
    );
    expect(isIndexableSessionTranscriptFileName("abc.jsonl.bak.2026-02-16T10-46-16.541Z")).toBe(
      false,
    );
    expect(isIndexableSessionTranscriptFileName("abc.md")).toBe(false);
  });

  it("lists active, reset, and deleted transcript files for an agent", async () => {
    const stateDir = path.join(tmpDir, "state");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(path.join(sessionsDir, "active.jsonl"), "");
    await fs.writeFile(path.join(sessionsDir, "archived.jsonl.reset.2026-02-14T19-44-05.473Z"), "");
    await fs.writeFile(path.join(sessionsDir, "pruned.jsonl.deleted.2026-02-16T10-46-16.541Z"), "");
    await fs.writeFile(path.join(sessionsDir, "ignored.jsonl.bak.2026-02-16T10-46-16.541Z"), "");
    await fs.writeFile(path.join(sessionsDir, "ignored.md"), "");

    const files = await listSessionFilesForAgent("main");
    expect(files.map((file) => path.basename(file)).toSorted()).toEqual([
      "active.jsonl",
      "archived.jsonl.reset.2026-02-14T19-44-05.473Z",
      "pruned.jsonl.deleted.2026-02-16T10-46-16.541Z",
    ]);
  });
});
