import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempDir } from "../../test-helpers/temp-dir.js";
import {
  resolveTrajectoryFilePath,
  resolveTrajectoryPointerFilePath,
} from "../../trajectory/paths.js";
import { enforceSessionDiskBudget } from "./disk-budget.js";
import type { SessionEntry } from "./types.js";

describe("enforceSessionDiskBudget", () => {
  it("removes unreferenced trajectory sidecars while preserving referenced ones", async () => {
    await withTempDir({ prefix: "openclaw-disk-budget-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const sessionId = "keep";
      const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
      const referencedRuntime = resolveTrajectoryFilePath({
        env: {},
        sessionFile: transcriptPath,
        sessionId,
      });
      const referencedPointer = resolveTrajectoryPointerFilePath(transcriptPath);
      const orphanRuntime = path.join(dir, "old.trajectory.jsonl");
      const orphanPointer = path.join(dir, "old.trajectory-path.json");
      const store: Record<string, SessionEntry> = {
        "agent:main:main": {
          sessionId,
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
        },
      };
      await fs.writeFile(referencedRuntime, "r".repeat(80), "utf-8");
      await fs.writeFile(referencedPointer, "p".repeat(80), "utf-8");
      await fs.writeFile(orphanRuntime, "o".repeat(5000), "utf-8");
      await fs.writeFile(orphanPointer, "q".repeat(5000), "utf-8");

      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        maintenance: {
          maxDiskBytes: 7000,
          highWaterBytes: 2000,
        },
        warnOnly: false,
      });

      await expect(fs.stat(referencedRuntime)).resolves.toBeDefined();
      await expect(fs.stat(referencedPointer)).resolves.toBeDefined();
      await expect(fs.stat(orphanRuntime)).rejects.toThrow();
      await expect(fs.stat(orphanPointer)).rejects.toThrow();
      expect(result).toEqual(
        expect.objectContaining({
          removedFiles: 2,
          removedEntries: 0,
        }),
      );
    });
  });

  it("does not evict protected thread session entries under store pressure", async () => {
    await withTempDir({ prefix: "openclaw-disk-budget-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const protectedKey = "agent:main:slack:channel:C123:thread:1710000000.000100";
      const removableKey = "agent:main:subagent:old-worker";
      const activeKey = "agent:main:main";
      const removableSessionFile = path.join(dir, "removable-worker.jsonl");
      const removableRuntime = resolveTrajectoryFilePath({
        env: {},
        sessionFile: removableSessionFile,
        sessionId: "removable-worker",
      });
      const store: Record<string, SessionEntry> = {
        [protectedKey]: {
          sessionId: "protected-thread",
          updatedAt: 1,
          displayName: "p".repeat(2000),
        },
        [removableKey]: {
          sessionId: "removable-worker",
          sessionFile: removableSessionFile,
          updatedAt: 2,
          displayName: "r".repeat(2000),
        },
        [activeKey]: {
          sessionId: "active",
          updatedAt: 3,
        },
      };
      await fs.writeFile(removableRuntime, "w".repeat(800), "utf-8");

      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        activeSessionKey: activeKey,
        maintenance: {
          maxDiskBytes: 600,
          highWaterBytes: 200,
        },
        warnOnly: false,
      });

      expect(store[protectedKey]).toBeDefined();
      expect(store[removableKey]).toBeUndefined();
      expect(store[activeKey]).toBeDefined();
      expect(result).toEqual(
        expect.objectContaining({
          removedEntries: 1,
          removedFiles: 1,
        }),
      );
    });
  });
});
