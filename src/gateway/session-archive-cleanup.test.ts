import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatSessionArchiveTimestamp } from "../config/sessions/artifacts.js";
import { sweepSessionArchiveFiles } from "./session-archive-cleanup.js";

// Mock resolveAgentSessionDirs to return our temp directories instead of
// reading the real state dir.
const mocks = vi.hoisted(() => ({
  resolveAgentSessionDirs: vi.fn<(stateDir: string) => Promise<string[]>>(),
  resolveAgentSessionDirsFromAgentsDir: vi.fn<(agentsDir: string) => Promise<string[]>>(),
  resolveAgentSessionDirsFromAgentsDirSync: vi.fn<(agentsDir: string) => string[]>(),
  resolveMaintenanceConfigFromInput: vi.fn(),
  resolveAllAgentSessionStoreTargets: vi.fn(),
}));
vi.mock("../agents/session-dirs.js", () => ({
  resolveAgentSessionDirs: mocks.resolveAgentSessionDirs,
  resolveAgentSessionDirsFromAgentsDir: mocks.resolveAgentSessionDirsFromAgentsDir,
  resolveAgentSessionDirsFromAgentsDirSync: mocks.resolveAgentSessionDirsFromAgentsDirSync,
}));
vi.mock("../config/sessions/store-maintenance.js", () => ({
  resolveMaintenanceConfigFromInput: mocks.resolveMaintenanceConfigFromInput,
}));
vi.mock("../config/sessions/targets.js", () => ({
  resolveAllAgentSessionStoreTargets: mocks.resolveAllAgentSessionStoreTargets,
}));

describe("sweepSessionArchiveFiles", () => {
  let tempDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "archive-cleanup-"));
    sessionsDir = path.join(tempDir, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    mocks.resolveAgentSessionDirs.mockResolvedValue([sessionsDir]);
    mocks.resolveAllAgentSessionStoreTargets.mockResolvedValue([]);
    mocks.resolveMaintenanceConfigFromInput.mockReturnValue({
      mode: "warn",
      pruneAfterMs: 30 * 24 * 60 * 60 * 1000,
      maxEntries: 500,
      rotateBytes: 10_485_760,
      resetArchiveRetentionMs: 30 * 24 * 60 * 60 * 1000,
      maxDiskBytes: undefined,
      highWaterBytes: undefined,
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("removes old .deleted and .reset archive files", async () => {
    const oldStamp = formatSessionArchiveTimestamp(Date.now() - 60 * 24 * 60 * 60 * 1000);
    const recentStamp = formatSessionArchiveTimestamp(Date.now() - 1000);

    // Old archives should be cleaned up.
    fs.writeFileSync(path.join(sessionsDir, `old.jsonl.deleted.${oldStamp}`), "");
    fs.writeFileSync(path.join(sessionsDir, `old.jsonl.reset.${oldStamp}`), "");
    // Recent archives should survive.
    fs.writeFileSync(path.join(sessionsDir, `recent.jsonl.deleted.${recentStamp}`), "");

    const result = await sweepSessionArchiveFiles({ stateDir: tempDir });

    expect(result.removed).toBe(2);
    expect(result.directories).toBe(1);
    expect(fs.existsSync(path.join(sessionsDir, `recent.jsonl.deleted.${recentStamp}`))).toBe(true);
  });

  it("preserves active .jsonl transcript files", async () => {
    const oldStamp = formatSessionArchiveTimestamp(Date.now() - 60 * 24 * 60 * 60 * 1000);

    fs.writeFileSync(path.join(sessionsDir, "active-session.jsonl"), "active content");
    fs.writeFileSync(path.join(sessionsDir, "sessions.json"), "{}");
    fs.writeFileSync(path.join(sessionsDir, `old.jsonl.deleted.${oldStamp}`), "");

    const result = await sweepSessionArchiveFiles({ stateDir: tempDir });

    expect(result.removed).toBe(1);
    expect(fs.existsSync(path.join(sessionsDir, "active-session.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(sessionsDir, "sessions.json"))).toBe(true);
  });

  it("removes orphaned .tmp files older than 1 hour", async () => {
    const oldTmp = path.join(sessionsDir, "sessions.json.550e8400-e29b-41d4-a716-446655440000.tmp");
    const recentTmp = path.join(
      sessionsDir,
      "sessions.json.a1b2c3d4-e5f6-7890-abcd-ef1234567890.tmp",
    );

    fs.writeFileSync(oldTmp, "stale data");
    fs.writeFileSync(recentTmp, "recent data");

    // Backdate the old file's mtime by 2 hours.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(oldTmp, twoHoursAgo, twoHoursAgo);

    const result = await sweepSessionArchiveFiles({ stateDir: tempDir });

    expect(result.removed).toBe(1);
    expect(fs.existsSync(oldTmp)).toBe(false);
    expect(fs.existsSync(recentTmp)).toBe(true);
  });

  it("trims excess .bak files keeping only 3 most recent per base", async () => {
    // Create 5 .bak files with deterministic timestamps spaced 10s apart.
    const baseTime = Date.parse("2026-01-15T12:00:00.000Z");
    const stamps: string[] = [];
    for (let i = 0; i < 5; i++) {
      const stamp = formatSessionArchiveTimestamp(baseTime + i * 10_000);
      stamps.push(stamp);
      fs.writeFileSync(path.join(sessionsDir, `sessions.json.bak.${stamp}`), `data-${i}`);
    }

    const result = await sweepSessionArchiveFiles({ stateDir: tempDir });

    const remaining = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.startsWith("sessions.json.bak."))
      .toSorted();
    expect(remaining).toHaveLength(3);
    expect(result.removed).toBe(2);
    // The 3 newest should survive (stamps[2], stamps[3], stamps[4]).
    expect(remaining).toEqual([
      `sessions.json.bak.${stamps[2]}`,
      `sessions.json.bak.${stamps[3]}`,
      `sessions.json.bak.${stamps[4]}`,
    ]);
  });

  it("trims legacy numeric .bak files from rotateSessionFile", async () => {
    // rotateSessionFile() creates backups as sessions.json.bak.${Date.now()}.
    const baseTs = Date.now();
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(sessionsDir, `sessions.json.bak.${baseTs + i * 1000}`), "");
    }

    const result = await sweepSessionArchiveFiles({ stateDir: tempDir });

    const remaining = fs.readdirSync(sessionsDir).filter((f) => f.startsWith("sessions.json.bak."));
    expect(remaining).toHaveLength(3);
    expect(result.removed).toBe(2);
  });

  it("cleans up archives when retention is zero (immediate cleanup)", async () => {
    mocks.resolveMaintenanceConfigFromInput.mockReturnValue({
      mode: "warn",
      pruneAfterMs: 0,
      maxEntries: 500,
      rotateBytes: 10_485_760,
      resetArchiveRetentionMs: 0,
      maxDiskBytes: undefined,
      highWaterBytes: undefined,
    });

    const recentStamp = formatSessionArchiveTimestamp(Date.now() - 1000);
    fs.writeFileSync(path.join(sessionsDir, `s.jsonl.deleted.${recentStamp}`), "");
    fs.writeFileSync(path.join(sessionsDir, `s.jsonl.reset.${recentStamp}`), "");

    const result = await sweepSessionArchiveFiles({ stateDir: tempDir });

    // Both files should be removed since retention=0 means "clean up everything".
    expect(result.removed).toBe(2);
    expect(fs.readdirSync(sessionsDir)).toHaveLength(0);
  });

  it("forwards configured session.maintenance to the resolver", async () => {
    const maintenance = {
      mode: "warn" as const,
      pruneAfter: "7d",
      resetArchiveRetention: false as const,
    };
    await sweepSessionArchiveFiles({
      stateDir: tempDir,
      cfg: { session: { maintenance } } as never,
    });

    expect(mocks.resolveMaintenanceConfigFromInput).toHaveBeenCalledWith(maintenance);
  });

  it("returns zeros when no agent session directories exist", async () => {
    mocks.resolveAgentSessionDirs.mockResolvedValue([]);
    const result = await sweepSessionArchiveFiles({ stateDir: tempDir });
    expect(result).toEqual({ removed: 0, directories: 0 });
  });
});
