import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planArchivedSessionFileCleanup } from "./cleanup-service.js";

const NOW = Date.UTC(2026, 5, 1, 0, 0, 0);
const DAY = 86_400_000;

function tsName(daysAgo: number): string {
  return new Date(NOW - daysAgo * DAY).toISOString().replaceAll(":", "-");
}

function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-sessions-cleanup-arch-"));
  return dir;
}

describe("planArchivedSessionFileCleanup (#75658)", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeFixture();
    // Treat dir as the directory that owns the store, write a sessions.json
    // so loadSessionStore can resolve at least an empty referenced-id set.
    fs.writeFileSync(path.join(dir, "sessions.json"), "{}");
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    vi.restoreAllMocks();
  });

  function write(name: string, size: number): string {
    const full = path.join(dir, name);
    fs.writeFileSync(full, "x".repeat(size));
    return full;
  }

  it("dry-run reports candidates without deleting anything", () => {
    const oldDeleted = write(`oldsess.jsonl.deleted.${tsName(40)}`, 1000);
    const recentDeleted = write(`newsess.jsonl.deleted.${tsName(2)}`, 500);

    const plan = planArchivedSessionFileCleanup({
      storePath: path.join(dir, "sessions.json"),
      pruneAfterMs: 30 * DAY,
      resetArchiveRetentionMs: 14 * DAY,
      dryRun: true,
      nowMs: NOW,
    });

    expect(plan.scannedDeleted).toBe(2);
    expect(plan.removedDeleted).toBe(1);
    // Both files still on disk.
    expect(fs.existsSync(oldDeleted)).toBe(true);
    expect(fs.existsSync(recentDeleted)).toBe(true);
    expect(plan.candidatePaths).toContain(oldDeleted);
    expect(plan.candidatePaths).not.toContain(recentDeleted);
    expect(plan.bytesFreed).toBe(1000);
  });

  it("apply removes .deleted, .reset, and orphan checkpoint files past retention", () => {
    const oldDeleted = write(`oldsess.jsonl.deleted.${tsName(40)}`, 1000);
    const recentDeleted = write(`newsess.jsonl.deleted.${tsName(2)}`, 500);
    const oldReset = write(`oldreset.jsonl.reset.${tsName(20)}`, 800);
    const recentReset = write(`newreset.jsonl.reset.${tsName(2)}`, 300);
    const orphanCheckpoint = write(
      `gone.checkpoint.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl`,
      700,
    );
    const liveCheckpoint = write(`live.checkpoint.aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff.jsonl`, 600);
    const unrelated = write("unrelated.txt", 50);

    // Inject a "live" session id by replacing the stub sessions.json so the
    // helper's referenced-session lookup keeps live.checkpoint untouched.
    fs.writeFileSync(
      path.join(dir, "sessions.json"),
      JSON.stringify({ "live-key": { sessionId: "live" } }),
    );

    const plan = planArchivedSessionFileCleanup({
      storePath: path.join(dir, "sessions.json"),
      pruneAfterMs: 30 * DAY,
      resetArchiveRetentionMs: 14 * DAY,
      dryRun: false,
      nowMs: NOW,
    });

    expect(plan.removedDeleted).toBe(1);
    expect(plan.removedReset).toBe(1);
    expect(plan.removedOrphanCheckpoint).toBe(1);

    expect(fs.existsSync(oldDeleted)).toBe(false);
    expect(fs.existsSync(recentDeleted)).toBe(true);
    expect(fs.existsSync(oldReset)).toBe(false);
    expect(fs.existsSync(recentReset)).toBe(true);
    expect(fs.existsSync(orphanCheckpoint)).toBe(false);
    expect(fs.existsSync(liveCheckpoint)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it("preserves .reset files when resetArchiveRetentionMs is null", () => {
    const oldReset = write(`oldreset.jsonl.reset.${tsName(60)}`, 800);
    const oldDeleted = write(`oldsess.jsonl.deleted.${tsName(60)}`, 1000);

    const plan = planArchivedSessionFileCleanup({
      storePath: path.join(dir, "sessions.json"),
      pruneAfterMs: 30 * DAY,
      resetArchiveRetentionMs: null,
      dryRun: false,
      nowMs: NOW,
    });

    expect(plan.scannedReset).toBe(1);
    expect(plan.removedReset).toBe(0);
    expect(fs.existsSync(oldReset)).toBe(true);
    // .deleted is still removed because pruneAfterMs always applies to it.
    expect(plan.removedDeleted).toBe(1);
    expect(fs.existsSync(oldDeleted)).toBe(false);
  });

  it("dry-run uses caller-provided referenced ids so orphan checkpoints match enforce", () => {
    // Owning sessions "keep" and "prune" both still appear in the live
    // sessions.json index. Enforce would prune "prune" before scanning
    // archives, leaving only "keep" referenced. Dry-run must report the
    // same result by accepting the simulated post-cleanup id set.
    fs.writeFileSync(
      path.join(dir, "sessions.json"),
      JSON.stringify({
        "keep-key": { sessionId: "keep" },
        "prune-key": { sessionId: "prune" },
      }),
    );
    write(`keep.checkpoint.aaaaaaaa-bbbb-4ccc-8ddd-000000000001.jsonl`, 100);
    write(`prune.checkpoint.aaaaaaaa-bbbb-4ccc-8ddd-000000000002.jsonl`, 200);

    // Without the simulated set, both checkpoints are considered referenced.
    const naiveDryRun = planArchivedSessionFileCleanup({
      storePath: path.join(dir, "sessions.json"),
      pruneAfterMs: 30 * DAY,
      resetArchiveRetentionMs: 14 * DAY,
      dryRun: true,
      nowMs: NOW,
    });
    expect(naiveDryRun.removedOrphanCheckpoint).toBe(0);

    // With the simulated set (only "keep" remains after pruning), the
    // orphaned checkpoint for "prune" is correctly flagged.
    const simulatedDryRun = planArchivedSessionFileCleanup({
      storePath: path.join(dir, "sessions.json"),
      pruneAfterMs: 30 * DAY,
      resetArchiveRetentionMs: 14 * DAY,
      dryRun: true,
      nowMs: NOW,
      referencedSessionIds: new Set(["keep"]),
    });
    expect(simulatedDryRun.removedOrphanCheckpoint).toBe(1);
    expect(simulatedDryRun.scannedOrphanCheckpoint).toBe(2);
  });

  it("returns an empty plan when the store directory does not exist", () => {
    const missingDir = path.join(dir, "does-not-exist");
    const plan = planArchivedSessionFileCleanup({
      storePath: path.join(missingDir, "sessions.json"),
      pruneAfterMs: 30 * DAY,
      resetArchiveRetentionMs: 14 * DAY,
      dryRun: true,
      nowMs: NOW,
    });

    expect(plan.scannedDeleted).toBe(0);
    expect(plan.scannedReset).toBe(0);
    expect(plan.scannedOrphanCheckpoint).toBe(0);
    expect(plan.candidatePaths).toEqual([]);
  });
});
