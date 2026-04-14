import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import {
  resolveMaintenanceConfigFromInput,
  rotateTranscriptFile,
  rotateTranscriptFiles,
} from "./store-maintenance.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";

const fixtureSuite = createFixtureSuite("openclaw-transcript-rotation-suite-");

beforeAll(async () => {
  await fixtureSuite.setup();
});

afterAll(async () => {
  await fixtureSuite.cleanup();
});

function makeMaintenance(
  overrides: Partial<ResolvedSessionMaintenanceConfig> = {},
): ResolvedSessionMaintenanceConfig {
  return {
    mode: "enforce",
    pruneAfterMs: 30 * 24 * 60 * 60 * 1000,
    maxEntries: 500,
    rotateBytes: 10_485_760,
    resetArchiveRetentionMs: null,
    maxDiskBytes: null,
    highWaterBytes: null,
    transcriptRotateBytes: null,
    transcriptMaxLines: null,
    ...overrides,
  };
}

function jsonlLine(index: number): string {
  return JSON.stringify({ role: "user", content: `message-${index}` });
}

/** A valid session header line for test transcript files. */
const SESSION_HEADER = JSON.stringify({
  type: "session",
  version: 1,
  id: "test-session-id",
  timestamp: "2026-04-14T00:00:00.000Z",
  cwd: "/test",
});

function writeJsonlLines(filePath: string, count: number, lineSize = 50): Promise<void> {
  const lines: string[] = [SESSION_HEADER];
  for (let i = 0; i < count; i++) {
    const base = jsonlLine(i);
    // Pad to approximate lineSize for predictable file sizes
    const padded = base.length >= lineSize ? base : base + " ".repeat(lineSize - base.length);
    lines.push(padded);
  }
  return fs.writeFile(filePath, lines.join("\n") + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// resolveTranscriptRotateBytes / resolveTranscriptMaxLines (via resolveMaintenanceConfigFromInput)
// ---------------------------------------------------------------------------

describe("resolveMaintenanceConfigFromInput — transcript fields", () => {
  it("returns null for transcriptRotateBytes when not configured", () => {
    const config = resolveMaintenanceConfigFromInput(undefined);
    expect(config.transcriptRotateBytes).toBeNull();
    expect(config.transcriptMaxLines).toBeNull();
  });

  it("parses transcriptRotateBytes from string", () => {
    const config = resolveMaintenanceConfigFromInput({
      transcriptRotateBytes: "10mb",
    });
    expect(config.transcriptRotateBytes).toBe(10 * 1024 * 1024);
  });

  it("parses transcriptRotateBytes from number", () => {
    const config = resolveMaintenanceConfigFromInput({
      transcriptRotateBytes: 5_000_000,
    });
    expect(config.transcriptRotateBytes).toBe(5_000_000);
  });

  it("parses transcriptMaxLines from number", () => {
    const config = resolveMaintenanceConfigFromInput({
      transcriptMaxLines: 500,
    });
    expect(config.transcriptMaxLines).toBe(500);
  });

  it("returns null for invalid transcriptMaxLines", () => {
    expect(
      resolveMaintenanceConfigFromInput({ transcriptMaxLines: -1 }).transcriptMaxLines,
    ).toBeNull();
    expect(
      resolveMaintenanceConfigFromInput({ transcriptMaxLines: 0 }).transcriptMaxLines,
    ).toBeNull();
  });

  it("returns null for NaN transcriptMaxLines", () => {
    const config = resolveMaintenanceConfigFromInput({ transcriptMaxLines: NaN });
    expect(config.transcriptMaxLines).toBeNull();
  });

  it("returns null for Infinity transcriptMaxLines", () => {
    const config = resolveMaintenanceConfigFromInput({ transcriptMaxLines: Infinity });
    expect(config.transcriptMaxLines).toBeNull();
  });

  it("returns null for invalid transcriptRotateBytes string", () => {
    const config = resolveMaintenanceConfigFromInput({ transcriptRotateBytes: "not-bytes" });
    expect(config.transcriptRotateBytes).toBeNull();
  });

  it("returns null for transcriptRotateBytes of 0", () => {
    const config = resolveMaintenanceConfigFromInput({ transcriptRotateBytes: 0 });
    expect(config.transcriptRotateBytes).toBeNull();
  });

  it("returns null for negative transcriptRotateBytes", () => {
    const config = resolveMaintenanceConfigFromInput({ transcriptRotateBytes: -100 });
    expect(config.transcriptRotateBytes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// rotateTranscriptFiles
// ---------------------------------------------------------------------------

describe("rotateTranscriptFiles", () => {
  let testDir: string;
  let sessionsDir: string;
  let storePath: string;

  beforeEach(async () => {
    testDir = await fixtureSuite.createCaseDir("rotate-transcript");
    sessionsDir = path.join(testDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    storePath = path.join(sessionsDir, "sessions.json");
    await fs.writeFile(storePath, "{}", "utf-8");
  });

  it("returns 0 when transcriptRotateBytes is null (disabled)", async () => {
    const maintenance = makeMaintenance({ transcriptRotateBytes: null });
    const rotated = await rotateTranscriptFiles({ storePath, maintenance });
    expect(rotated).toBe(0);
  });

  it("returns 0 when transcriptRotateBytes is 0", async () => {
    const maintenance = makeMaintenance({ transcriptRotateBytes: 0 });
    const rotated = await rotateTranscriptFiles({ storePath, maintenance });
    expect(rotated).toBe(0);
  });

  it("does not rotate .jsonl file under threshold", async () => {
    const jsonlPath = path.join(sessionsDir, "topic-2.jsonl");
    await writeJsonlLines(jsonlPath, 10);

    const statBefore = await fs.stat(jsonlPath);
    const maintenance = makeMaintenance({
      transcriptRotateBytes: statBefore.size + 1000,
      transcriptMaxLines: 5,
    });

    const rotated = await rotateTranscriptFiles({ storePath, maintenance });
    expect(rotated).toBe(0);

    // File unchanged
    const statAfter = await fs.stat(jsonlPath);
    expect(statAfter.size).toBe(statBefore.size);
  });

  it("rotates oversized .jsonl and keeps last N lines", async () => {
    const jsonlPath = path.join(sessionsDir, "topic-2.jsonl");
    await writeJsonlLines(jsonlPath, 100, 60);

    const statBefore = await fs.stat(jsonlPath);
    const maintenance = makeMaintenance({
      transcriptRotateBytes: Math.floor(statBefore.size / 2),
      transcriptMaxLines: 10,
    });

    const rotated = await rotateTranscriptFiles({ storePath, maintenance });
    expect(rotated).toBe(1);

    // Replacement file should be smaller
    const statAfter = await fs.stat(jsonlPath);
    expect(statAfter.size).toBeLessThan(statBefore.size);

    // Replacement should have 1 header line + 10 message lines
    const content = await fs.readFile(jsonlPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(11);

    // First line should be the session header
    const header = JSON.parse(lines[0]);
    expect(header.type).toBe("session");

    // Backup file should exist
    const files = await fs.readdir(sessionsDir);
    const bakFiles = files.filter((f) => f.startsWith("topic-2.jsonl.bak."));
    expect(bakFiles).toHaveLength(1);
  });

  it("rotates .jsonl in subdirectories", async () => {
    const subDir = path.join(sessionsDir, "daily-devops");
    await fs.mkdir(subDir, { recursive: true });
    const jsonlPath = path.join(subDir, "topic-8.jsonl");
    await writeJsonlLines(jsonlPath, 50, 80);

    const statBefore = await fs.stat(jsonlPath);
    const maintenance = makeMaintenance({
      transcriptRotateBytes: Math.floor(statBefore.size / 2),
      transcriptMaxLines: 5,
    });

    const rotated = await rotateTranscriptFiles({ storePath, maintenance });
    expect(rotated).toBe(1);

    const content = await fs.readFile(jsonlPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    // 1 header line + 5 message lines
    expect(lines).toHaveLength(6);
    const header = JSON.parse(lines[0]);
    expect(header.type).toBe("session");
  });

  it("writes header-only replacement when transcriptMaxLines is null", async () => {
    const jsonlPath = path.join(sessionsDir, "session.jsonl");
    await writeJsonlLines(jsonlPath, 50, 80);

    const statBefore = await fs.stat(jsonlPath);
    const maintenance = makeMaintenance({
      transcriptRotateBytes: Math.floor(statBefore.size / 2),
      transcriptMaxLines: null,
    });

    const rotated = await rotateTranscriptFiles({ storePath, maintenance });
    expect(rotated).toBe(1);

    // Replacement should contain only the session header
    const content = await fs.readFile(jsonlPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const header = JSON.parse(lines[0]);
    expect(header.type).toBe("session");
  });

  it("prunes old .bak files keeping only 3 most recent", async () => {
    const jsonlPath = path.join(sessionsDir, "topic-2.jsonl");
    let now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => (now += 10));

    try {
      const maintenance = makeMaintenance({
        transcriptRotateBytes: 100, // Very small threshold
        transcriptMaxLines: 5,
      });

      // Rotate 5 times
      for (let i = 0; i < 5; i++) {
        await writeJsonlLines(jsonlPath, 20, 60);
        await rotateTranscriptFiles({ storePath, maintenance });
      }
    } finally {
      nowSpy.mockRestore();
    }

    // Should have at most 3 .bak files
    const files = await fs.readdir(sessionsDir);
    const bakFiles = files.filter((f) => f.startsWith("topic-2.jsonl.bak."));
    expect(bakFiles.length).toBeLessThanOrEqual(3);
  });

  it("ignores non-.jsonl files", async () => {
    const txtPath = path.join(sessionsDir, "notes.txt");
    await fs.writeFile(txtPath, "x".repeat(10000), "utf-8");

    const maintenance = makeMaintenance({
      transcriptRotateBytes: 100,
      transcriptMaxLines: 5,
    });

    const rotated = await rotateTranscriptFiles({ storePath, maintenance });
    expect(rotated).toBe(0);

    // File unchanged
    const content = await fs.readFile(txtPath, "utf-8");
    expect(content).toBe("x".repeat(10000));
  });

  it("ignores .jsonl.bak.* archive files", async () => {
    const bakPath = path.join(sessionsDir, "session.jsonl.bak.2026-04-14T10-17-22.333Z");
    await writeJsonlLines(bakPath, 50, 80);

    const maintenance = makeMaintenance({
      transcriptRotateBytes: 100,
      transcriptMaxLines: 5,
    });

    const rotated = await rotateTranscriptFiles({ storePath, maintenance });
    expect(rotated).toBe(0);
  });

  it("rotates multiple .jsonl files in the same directory", async () => {
    const jsonl1 = path.join(sessionsDir, "topic-1.jsonl");
    const jsonl2 = path.join(sessionsDir, "topic-2.jsonl");
    await writeJsonlLines(jsonl1, 50, 80);
    await writeJsonlLines(jsonl2, 50, 80);

    const maintenance = makeMaintenance({
      transcriptRotateBytes: 500,
      transcriptMaxLines: 5,
    });

    const rotated = await rotateTranscriptFiles({ storePath, maintenance });
    expect(rotated).toBe(2);
  });

  it("handles missing sessions directory gracefully", async () => {
    const missingDir = path.join(testDir, "no-such-dir");
    const missingStorePath = path.join(missingDir, "sessions.json");

    const maintenance = makeMaintenance({
      transcriptRotateBytes: 100,
      transcriptMaxLines: 5,
    });

    const rotated = await rotateTranscriptFiles({ storePath: missingStorePath, maintenance });
    expect(rotated).toBe(0);
  });

  it("skips .jsonl file that disappears between readdir and stat", async () => {
    const jsonlPath = path.join(sessionsDir, "topic-2.jsonl");
    await writeJsonlLines(jsonlPath, 50, 80);

    const maintenance = makeMaintenance({
      transcriptRotateBytes: 100,
      transcriptMaxLines: 5,
    });

    // Remove file before rotation runs so stat fails
    await fs.unlink(jsonlPath);

    const rotated = await rotateTranscriptFiles({ storePath, maintenance });
    expect(rotated).toBe(0);
  });

  it("writes header-only replacement when transcriptMaxLines is 0", async () => {
    const jsonlPath = path.join(sessionsDir, "session.jsonl");
    await writeJsonlLines(jsonlPath, 50, 80);

    const statBefore = await fs.stat(jsonlPath);
    const maintenance = makeMaintenance({
      transcriptRotateBytes: Math.floor(statBefore.size / 2),
      transcriptMaxLines: 0,
    });

    const rotated = await rotateTranscriptFiles({ storePath, maintenance });
    expect(rotated).toBe(1);

    // Replacement should contain only the session header (maxLines <= 0 branch)
    const content = await fs.readFile(jsonlPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const header = JSON.parse(lines[0]);
    expect(header.type).toBe("session");
  });

  it("preserves last N lines in correct order after rotation", async () => {
    const jsonlPath = path.join(sessionsDir, "topic-2.jsonl");
    // Write header + 20 lines with unique content
    const lines: string[] = [SESSION_HEADER];
    for (let i = 0; i < 20; i++) {
      lines.push(JSON.stringify({ i, text: `line-${i}` }));
    }
    await fs.writeFile(jsonlPath, lines.join("\n") + "\n", "utf-8");

    const statBefore = await fs.stat(jsonlPath);
    const maintenance = makeMaintenance({
      transcriptRotateBytes: Math.floor(statBefore.size / 2),
      transcriptMaxLines: 5,
    });

    await rotateTranscriptFiles({ storePath, maintenance });

    const content = await fs.readFile(jsonlPath, "utf-8");
    const kept = content.trim().split("\n").filter(Boolean);
    // 1 header + 5 message lines
    expect(kept).toHaveLength(6);
    // First line is the session header
    const header = JSON.parse(kept[0]);
    expect(header.type).toBe("session");
    // Should be the LAST 5 message lines (indices 15-19)
    expect(JSON.parse(kept[1]).i).toBe(15);
    expect(JSON.parse(kept[5]).i).toBe(19);
  });

  it("preserves session header id from original file", async () => {
    const jsonlPath = path.join(sessionsDir, "session.jsonl");
    const customHeader = JSON.stringify({
      type: "session",
      version: 1,
      id: "custom-session-42",
      timestamp: "2026-04-14T00:00:00.000Z",
      cwd: "/test",
    });
    const lines = [customHeader];
    for (let i = 0; i < 50; i++) {
      lines.push(jsonlLine(i));
    }
    await fs.writeFile(jsonlPath, lines.join("\n") + "\n", "utf-8");

    const statBefore = await fs.stat(jsonlPath);
    const maintenance = makeMaintenance({
      transcriptRotateBytes: Math.floor(statBefore.size / 2),
      transcriptMaxLines: 5,
    });

    await rotateTranscriptFiles({ storePath, maintenance });

    const content = await fs.readFile(jsonlPath, "utf-8");
    const kept = content.trim().split("\n").filter(Boolean);
    const header = JSON.parse(kept.find(Boolean)!);
    expect(header.type).toBe("session");
    expect(header.id).toBe("custom-session-42");
  });

  it("creates replacement file with 0o600 permissions", async () => {
    const jsonlPath = path.join(sessionsDir, "session.jsonl");
    await writeJsonlLines(jsonlPath, 50, 80);

    const statBefore = await fs.stat(jsonlPath);
    const maintenance = makeMaintenance({
      transcriptRotateBytes: Math.floor(statBefore.size / 2),
      transcriptMaxLines: 5,
    });

    await rotateTranscriptFiles({ storePath, maintenance });

    const statAfter = await fs.stat(jsonlPath);
    // 0o600 = owner read+write only
    expect(statAfter.mode & 0o777).toBe(0o600);
  });
});

// ---------------------------------------------------------------------------
// rotateTranscriptFile (single-file hot-path)
// ---------------------------------------------------------------------------

describe("rotateTranscriptFile", () => {
  let testDir: string;
  let sessionsDir: string;

  beforeEach(async () => {
    testDir = await fixtureSuite.createCaseDir("rotate-transcript-file");
    sessionsDir = path.join(testDir, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
  });

  it("returns false when transcriptRotateBytes is null (disabled)", async () => {
    const jsonlPath = path.join(sessionsDir, "session.jsonl");
    await writeJsonlLines(jsonlPath, 50, 80);

    const maintenance = makeMaintenance({ transcriptRotateBytes: null });
    const rotated = await rotateTranscriptFile({ transcriptPath: jsonlPath, maintenance });
    expect(rotated).toBe(false);
  });

  it("returns false when transcriptRotateBytes is 0", async () => {
    const jsonlPath = path.join(sessionsDir, "session.jsonl");
    await writeJsonlLines(jsonlPath, 50, 80);

    const maintenance = makeMaintenance({ transcriptRotateBytes: 0 });
    const rotated = await rotateTranscriptFile({ transcriptPath: jsonlPath, maintenance });
    expect(rotated).toBe(false);
  });

  it("returns false when transcriptRotateBytes is negative", async () => {
    const jsonlPath = path.join(sessionsDir, "session.jsonl");
    await writeJsonlLines(jsonlPath, 50, 80);

    const maintenance = makeMaintenance({ transcriptRotateBytes: -1 });
    const rotated = await rotateTranscriptFile({ transcriptPath: jsonlPath, maintenance });
    expect(rotated).toBe(false);
  });

  it("returns false for file under threshold", async () => {
    const jsonlPath = path.join(sessionsDir, "session.jsonl");
    await writeJsonlLines(jsonlPath, 10);

    const statBefore = await fs.stat(jsonlPath);
    const maintenance = makeMaintenance({
      transcriptRotateBytes: statBefore.size + 1000,
      transcriptMaxLines: 5,
    });

    const rotated = await rotateTranscriptFile({ transcriptPath: jsonlPath, maintenance });
    expect(rotated).toBe(false);

    // File unchanged
    const statAfter = await fs.stat(jsonlPath);
    expect(statAfter.size).toBe(statBefore.size);
  });

  it("rotates oversized file and keeps last N lines", async () => {
    const jsonlPath = path.join(sessionsDir, "session.jsonl");
    await writeJsonlLines(jsonlPath, 100, 60);

    const statBefore = await fs.stat(jsonlPath);
    const maintenance = makeMaintenance({
      transcriptRotateBytes: Math.floor(statBefore.size / 2),
      transcriptMaxLines: 10,
    });

    const rotated = await rotateTranscriptFile({ transcriptPath: jsonlPath, maintenance });
    expect(rotated).toBe(true);

    // Replacement file should be smaller
    const statAfter = await fs.stat(jsonlPath);
    expect(statAfter.size).toBeLessThan(statBefore.size);

    // Replacement should have 1 header line + 10 message lines
    const content = await fs.readFile(jsonlPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(11);

    // First line should be the session header
    const header = JSON.parse(lines[0]);
    expect(header.type).toBe("session");

    // Backup file should exist
    const files = await fs.readdir(sessionsDir);
    const bakFiles = files.filter((f) => f.startsWith("session.jsonl.bak."));
    expect(bakFiles).toHaveLength(1);
  });

  it("returns false for non-existent file", async () => {
    const jsonlPath = path.join(sessionsDir, "no-such-file.jsonl");
    const maintenance = makeMaintenance({
      transcriptRotateBytes: 100,
      transcriptMaxLines: 5,
    });

    const rotated = await rotateTranscriptFile({ transcriptPath: jsonlPath, maintenance });
    expect(rotated).toBe(false);
  });

  it("writes header-only replacement when transcriptMaxLines is null", async () => {
    const jsonlPath = path.join(sessionsDir, "session.jsonl");
    await writeJsonlLines(jsonlPath, 50, 80);

    const statBefore = await fs.stat(jsonlPath);
    const maintenance = makeMaintenance({
      transcriptRotateBytes: Math.floor(statBefore.size / 2),
      transcriptMaxLines: null,
    });

    const rotated = await rotateTranscriptFile({ transcriptPath: jsonlPath, maintenance });
    expect(rotated).toBe(true);

    // Replacement should contain only the session header
    const content = await fs.readFile(jsonlPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const header = JSON.parse(lines[0]);
    expect(header.type).toBe("session");
  });

  it("preserves session header id from original file", async () => {
    const jsonlPath = path.join(sessionsDir, "session.jsonl");
    const customHeader = JSON.stringify({
      type: "session",
      version: 1,
      id: "hot-path-session-99",
      timestamp: "2026-04-14T00:00:00.000Z",
      cwd: "/test",
    });
    const lines = [customHeader];
    for (let i = 0; i < 50; i++) {
      lines.push(jsonlLine(i));
    }
    await fs.writeFile(jsonlPath, lines.join("\n") + "\n", "utf-8");

    const statBefore = await fs.stat(jsonlPath);
    const maintenance = makeMaintenance({
      transcriptRotateBytes: Math.floor(statBefore.size / 2),
      transcriptMaxLines: 5,
    });

    await rotateTranscriptFile({ transcriptPath: jsonlPath, maintenance });

    const content = await fs.readFile(jsonlPath, "utf-8");
    const kept = content.trim().split("\n").filter(Boolean);
    const header = JSON.parse(kept.find(Boolean)!);
    expect(header.type).toBe("session");
    expect(header.id).toBe("hot-path-session-99");
  });

  it("creates replacement file with 0o600 permissions", async () => {
    const jsonlPath = path.join(sessionsDir, "session.jsonl");
    await writeJsonlLines(jsonlPath, 50, 80);

    const statBefore = await fs.stat(jsonlPath);
    const maintenance = makeMaintenance({
      transcriptRotateBytes: Math.floor(statBefore.size / 2),
      transcriptMaxLines: 5,
    });

    await rotateTranscriptFile({ transcriptPath: jsonlPath, maintenance });

    const statAfter = await fs.stat(jsonlPath);
    expect(statAfter.mode & 0o777).toBe(0o600);
  });

  it("prunes old .bak files keeping only 3 most recent", async () => {
    const jsonlPath = path.join(sessionsDir, "session.jsonl");
    let now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => (now += 10));

    try {
      const maintenance = makeMaintenance({
        transcriptRotateBytes: 100,
        transcriptMaxLines: 5,
      });

      // Rotate 5 times
      for (let i = 0; i < 5; i++) {
        await writeJsonlLines(jsonlPath, 20, 60);
        await rotateTranscriptFile({ transcriptPath: jsonlPath, maintenance });
      }
    } finally {
      nowSpy.mockRestore();
    }

    // Should have at most 3 .bak files
    const files = await fs.readdir(sessionsDir);
    const bakFiles = files.filter((f) => f.startsWith("session.jsonl.bak."));
    expect(bakFiles.length).toBeLessThanOrEqual(3);
  });
});
