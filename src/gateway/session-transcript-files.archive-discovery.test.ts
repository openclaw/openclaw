import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  archiveFileOnDisk,
  enumerateArchivedTranscriptsInDir,
  resolveArchivedTranscriptPathWithin,
} from "./session-transcript-files.fs.js";

function setupTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `oc-archive-discovery-${prefix}-`));
}

function writeTranscript(filePath: string, lines: string[]): void {
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, { encoding: "utf-8", mode: 0o600 });
}

describe("enumerateArchivedTranscriptsInDir", () => {
  it("returns an empty list for a missing directory", () => {
    const result = enumerateArchivedTranscriptsInDir("/nonexistent-archive-discovery-path");
    expect(result).toEqual([]);
  });

  it("finds .jsonl.reset.<ts> and .jsonl.deleted.<ts> archives sorted by archivedAt desc", () => {
    const tmpDir = setupTmpDir("multi");
    try {
      const liveA = path.join(tmpDir, "11111111-1111-4111-8111-111111111111.jsonl");
      writeTranscript(liveA, ['{"type":"session"}', '{"role":"user","content":"hi"}']);
      const archivedA = archiveFileOnDisk(liveA, "reset");

      const liveB = path.join(tmpDir, "22222222-2222-4222-8222-222222222222.jsonl");
      writeTranscript(liveB, ['{"type":"session"}']);
      const archivedB = archiveFileOnDisk(liveB, "deleted");

      // Unrelated files must not appear.
      writeTranscript(path.join(tmpDir, "sessions.json"), ["{}"]);
      writeTranscript(path.join(tmpDir, "loose.txt"), ["nope"]);

      const result = enumerateArchivedTranscriptsInDir(tmpDir);
      expect(result).toHaveLength(2);
      const fileNames = result.map((entry) => entry.archivedFileName).toSorted();
      expect(fileNames).toContain(path.basename(archivedA));
      expect(fileNames).toContain(path.basename(archivedB));

      const reasons = new Set(result.map((entry) => entry.reason));
      expect(reasons).toEqual(new Set(["reset", "deleted"]));

      const sessionIds = new Set(result.map((entry) => entry.sessionId));
      expect(sessionIds).toEqual(
        new Set(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]),
      );

      // archivedAt must be a finite positive timestamp.
      for (const entry of result) {
        expect(Number.isFinite(entry.archivedAt)).toBe(true);
        expect(entry.archivedAt).toBeGreaterThan(0);
        expect(entry.sizeBytes).toBeGreaterThan(0);
      }

      // Sorted descending — most recent first.
      const timestamps = result.map((entry) => entry.archivedAt);
      const sorted = timestamps.toSorted((a, b) => b - a);
      expect(timestamps).toEqual(sorted);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("resolveArchivedTranscriptPathWithin", () => {
  it("resolves a valid archive name to its absolute path within the dir", () => {
    const tmpDir = setupTmpDir("resolve");
    try {
      const live = path.join(tmpDir, "33333333-3333-4333-8333-333333333333.jsonl");
      writeTranscript(live, ['{"type":"session"}']);
      const archived = archiveFileOnDisk(live, "reset");
      const archivedName = path.basename(archived);

      const resolved = resolveArchivedTranscriptPathWithin(tmpDir, archivedName);
      expect(resolved).not.toBeNull();
      expect(fs.realpathSync(resolved!)).toBe(fs.realpathSync(archived));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects path traversal and missing files", () => {
    const tmpDir = setupTmpDir("traverse");
    try {
      expect(
        resolveArchivedTranscriptPathWithin(
          tmpDir,
          "../../../etc/passwd.jsonl.reset.2026-05-05T09-57-18.833Z",
        ),
      ).toBeNull();

      // Wrong shape: missing reason / timestamp portion.
      expect(resolveArchivedTranscriptPathWithin(tmpDir, "anything.jsonl")).toBeNull();
      expect(resolveArchivedTranscriptPathWithin(tmpDir, "")).toBeNull();

      // Right shape but file does not exist on disk.
      expect(
        resolveArchivedTranscriptPathWithin(
          tmpDir,
          "44444444-4444-4444-8444-444444444444.jsonl.reset.2026-05-05T09-57-18.833Z",
        ),
      ).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
