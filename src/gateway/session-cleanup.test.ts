import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { resetSessionCleanupThrottle, sweepIdleSessions } from "./session-cleanup.js";

function makeSessionEntry(updatedAt: number, sessionId?: string): SessionEntry {
  return {
    sessionId: sessionId ?? `sid-${Math.random().toString(36).slice(2)}`,
    updatedAt,
  } as SessionEntry;
}

async function writeStore(storePath: string, store: Record<string, SessionEntry>): Promise<void> {
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  await fs.promises.writeFile(storePath, JSON.stringify(store, null, 2));
}

async function readStore(storePath: string): Promise<Record<string, SessionEntry>> {
  const raw = await fs.promises.readFile(storePath, "utf-8");
  return JSON.parse(raw) as Record<string, SessionEntry>;
}

describe("sweepIdleSessions", () => {
  let tmpDir: string;
  let stateDir: string;
  const log = { info: () => {}, warn: () => {} };

  beforeEach(async () => {
    resetSessionCleanupThrottle();
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "session-cleanup-test-"));
    stateDir = tmpDir;
    // Create agents directory structure
    await fs.promises.mkdir(path.join(stateDir, "agents"), { recursive: true });
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it("prunes stale entries across multiple agent stores", async () => {
    const now = Date.now();
    const oneDayAgo = now - 25 * 60 * 60 * 1000; // 25 hours ago (past 24h default)
    const recent = now - 1 * 60 * 60 * 1000; // 1 hour ago

    // Agent A: one stale, one recent
    const storeA = path.join(stateDir, "agents", "agent-a", "sessions", "sessions.json");
    await writeStore(storeA, {
      "session:stale": makeSessionEntry(oneDayAgo),
      "session:active": makeSessionEntry(recent),
    });

    // Agent B: all stale
    const storeB = path.join(stateDir, "agents", "agent-b", "sessions", "sessions.json");
    await writeStore(storeB, {
      "session:old1": makeSessionEntry(oneDayAgo - 1000),
      "session:old2": makeSessionEntry(oneDayAgo - 2000),
    });

    const result = await sweepIdleSessions({ stateDir, log, force: true, nowMs: now });

    expect(result.swept).toBe(true);
    expect(result.totalPruned).toBe(3);
    expect(result.storesChecked).toBe(2);

    // Verify agent A kept only the active session
    const storeAAfter = await readStore(storeA);
    expect(Object.keys(storeAAfter)).toEqual(["session:active"]);

    // Verify agent B store is empty
    const storeBAfter = await readStore(storeB);
    expect(Object.keys(storeBAfter)).toEqual([]);
  });

  it("preserves active (recent) sessions", async () => {
    const now = Date.now();
    const recent = now - 30 * 60 * 1000; // 30 minutes ago

    const storePath = path.join(stateDir, "agents", "agent-c", "sessions", "sessions.json");
    await writeStore(storePath, {
      "session:fresh": makeSessionEntry(recent),
    });

    const result = await sweepIdleSessions({ stateDir, log, force: true, nowMs: now });

    expect(result.swept).toBe(true);
    expect(result.totalPruned).toBe(0);

    const storeAfter = await readStore(storePath);
    expect(Object.keys(storeAfter)).toEqual(["session:fresh"]);
  });

  it("self-throttles to avoid excessive sweeps", async () => {
    const storePath = path.join(stateDir, "agents", "agent-d", "sessions", "sessions.json");
    await writeStore(storePath, {});

    // First sweep with force
    const r1 = await sweepIdleSessions({ stateDir, log, force: true });
    expect(r1.swept).toBe(true);

    // Second sweep without force — should be throttled
    const r2 = await sweepIdleSessions({ stateDir, log });
    expect(r2.swept).toBe(false);

    // Reset and try again
    resetSessionCleanupThrottle();
    const r3 = await sweepIdleSessions({ stateDir, log, force: true });
    expect(r3.swept).toBe(true);
  });

  it("handles missing store files gracefully", async () => {
    // Create agent dir without sessions.json
    await fs.promises.mkdir(path.join(stateDir, "agents", "agent-empty", "sessions"), {
      recursive: true,
    });

    const result = await sweepIdleSessions({ stateDir, log, force: true });

    expect(result.swept).toBe(true);
    expect(result.totalPruned).toBe(0);
    expect(result.storesChecked).toBe(0);
  });

  it("handles no agent directories gracefully", async () => {
    // stateDir/agents exists but is empty
    const result = await sweepIdleSessions({ stateDir, log, force: true });

    expect(result.swept).toBe(true);
    expect(result.totalPruned).toBe(0);
    expect(result.storesChecked).toBe(0);
  });
});
