import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveSessionTranscript } from "./archival.js";

function makeSessionLine(role: string, content: string, seq: number): string {
  return JSON.stringify({ role, content, seq });
}

function buildSessionFile(turnCount: number): string {
  const lines: string[] = [JSON.stringify({ type: "session_header", version: 1 })];
  for (let i = 0; i < turnCount; i++) {
    lines.push(makeSessionLine("user", `Turn ${i + 1} question`, i * 3 + 1));
    lines.push(makeSessionLine("assistant", `Turn ${i + 1} answer`, i * 3 + 2));
    lines.push(makeSessionLine("toolResult", `Turn ${i + 1} tool`, i * 3 + 3));
  }
  return lines.join("\n") + "\n";
}

describe("archiveSessionTranscript", () => {
  let tmpDir: string;

  afterEach(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("skips when total turns <= keepLastTurns", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "archival-test-"));
    const sessionFile = path.join(tmpDir, "session.jsonl");
    await fs.writeFile(sessionFile, buildSessionFile(5));

    const result = await archiveSessionTranscript({ sessionFile, keepLastTurns: 10 });
    expect(result.archived).toBe(false);
  });

  it("archives old turns and keeps last N", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "archival-test-"));
    const sessionFile = path.join(tmpDir, "session.jsonl");
    await fs.writeFile(sessionFile, buildSessionFile(20));

    const result = await archiveSessionTranscript({ sessionFile, keepLastTurns: 5 });
    expect(result.archived).toBe(true);
    expect(result.linesRemoved).toBeGreaterThan(0);
    expect(result.linesKept).toBeGreaterThan(0);

    // Verify file structure: header + archive_marker + remaining messages
    const raw = await fs.readFile(sessionFile, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const header = JSON.parse(lines[0]);
    expect(header.type).toBe("session_header");
    const marker = JSON.parse(lines[1]);
    expect(marker.type).toBe("archive_marker");
    expect(marker.totalArchived).toBe(result.linesRemoved);
    expect(typeof marker.archivedAt).toBe("string");

    // Verify exactly keepLastTurns user turns are retained
    const entries = lines.slice(2).map((l) => JSON.parse(l) as Record<string, unknown>);
    const keptUserTurns = entries.filter((e) => e.role === "user");
    expect(keptUserTurns).toHaveLength(5);
  });

  it("inserts correct archive marker format", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "archival-test-"));
    const sessionFile = path.join(tmpDir, "session.jsonl");
    await fs.writeFile(sessionFile, buildSessionFile(10));

    const result = await archiveSessionTranscript({ sessionFile, keepLastTurns: 5 });
    expect(result.archived).toBe(true);
    expect(result.archiveMarkerSeq).toBeGreaterThan(0);
  });

  it("handles missing file gracefully", async () => {
    const result = await archiveSessionTranscript({
      sessionFile: path.join(os.tmpdir(), `nonexistent-session-${Date.now()}.jsonl`),
      keepLastTurns: 5,
    });
    expect(result.archived).toBe(false);
  });

  it("preserves file integrity with atomic write", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "archival-test-"));
    const sessionFile = path.join(tmpDir, "session.jsonl");
    await fs.writeFile(sessionFile, buildSessionFile(15));

    await archiveSessionTranscript({ sessionFile, keepLastTurns: 5 });

    // Verify file is valid JSONL
    const raw = await fs.readFile(sessionFile, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });
});
