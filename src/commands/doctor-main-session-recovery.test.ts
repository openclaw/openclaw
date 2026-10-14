import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalSessionEntry } from "../config/sessions.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  inspectMainSessionRecoveryEntry,
  noteMainSessionRecoveryIntegrity,
} from "./doctor-main-session-recovery.js";

const agentId = "main";
const sessionKey = "agent:main:wedged-main";
const reason = "restart recovery exhausted after 3 attempts";
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-doctor-main-recovery-");

describe("doctor main-session recovery integrity", () => {
  let storePath = "";

  beforeEach(() => {
    storePath = path.join(sessionDirs.make(), "sessions.json");
  });

  async function writeTombstone(abortedLastRun: boolean): Promise<void> {
    await upsertSessionEntryCore({ agentId, sessionKey, storePath }, {
      sessionId: "session-wedged-main",
      updatedAt: abortedLastRun ? 0 : 1,
      status: "failed",
      abortedLastRun,
      mainRestartRecovery: {
        cycleId: "cycle-wedged-main",
        revision: 4,
        chargedAttempts: 3,
        tombstone: { reason },
      },
    } as InternalSessionEntry);
  }

  function recoveryScan() {
    const entry = loadSessionEntry({ sessionKey, storePath }) as InternalSessionEntry;
    const candidate = inspectMainSessionRecoveryEntry(sessionKey, entry);
    return { wedged: candidate ? [candidate] : [] };
  }

  it("warns about a tombstone without offering stale repair", async () => {
    await writeTombstone(false);
    const warnings: string[] = [];
    const changes: string[] = [];
    const confirmRepair = vi.fn(async () => false);

    await noteMainSessionRecoveryIntegrity({
      ...recoveryScan(),
      storePath,
      warnings,
      changes,
      confirmRepair,
    });

    expect(warnings.join("\n")).toContain("automatic restart recovery tombstoned");
    expect(warnings.join("\n")).toContain(sessionKey);
    expect(warnings.join("\n")).toContain(reason);
    expect(confirmRepair).not.toHaveBeenCalled();
    expect(changes).toEqual([]);
    expect(loadSessionEntry({ sessionKey, storePath })?.abortedLastRun).toBe(false);
  });

  it("clears a stale aborted flag while preserving the tombstone", async () => {
    await writeTombstone(true);
    const warnings: string[] = [];
    const changes: string[] = [];
    const confirmRepair = vi.fn(async () => true);

    await noteMainSessionRecoveryIntegrity({
      ...recoveryScan(),
      storePath,
      warnings,
      changes,
      confirmRepair,
    });

    expect(confirmRepair).toHaveBeenCalledWith({
      message: "Clear stale aborted recovery flags for 1 wedged main session?",
      initialValue: true,
    });
    const persisted = loadSessionEntry({ sessionKey, storePath }) as
      | InternalSessionEntry
      | undefined;
    expect(persisted?.abortedLastRun).toBe(false);
    expect(persisted?.updatedAt).toBeGreaterThan(0);
    expect(persisted?.mainRestartRecovery?.tombstone?.reason).toBe(reason);
    expect(changes).toEqual([
      "- Cleared aborted restart-recovery flags for 1 wedged main session.",
    ]);
  });
});
