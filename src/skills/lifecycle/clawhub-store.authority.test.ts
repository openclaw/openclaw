import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { recordClawHubSkillInstall } from "./clawhub-store.js";

afterEach(() => {
  vi.restoreAllMocks();
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function observePublication(filePath: string, isCurrent: () => boolean): boolean[] {
  const currentAtPublication: boolean[] = [];
  const renameSync = fsSync.renameSync.bind(fsSync);
  const rename = fs.rename.bind(fs);
  vi.spyOn(fsSync, "renameSync").mockImplementation((source, destination) => {
    if (String(destination) === filePath) {
      currentAtPublication.push(isCurrent());
    }
    renameSync(source, destination);
  });
  vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (String(destination) === filePath) {
      currentAtPublication.push(isCurrent());
    }
    await rename(source, destination);
  });
  return currentAtPublication;
}

async function withTrackingPaths<T>(
  run: (paths: {
    workspaceDir: string;
    skillDir: string;
    originPath: string;
    lockPath: string;
  }) => Promise<T>,
): Promise<T> {
  const workspaceDir = tempDirs.make("clawhub-store-authority-");
  const skillDir = path.join(workspaceDir, "skills", "canary");
  return await run({
    workspaceDir,
    skillDir,
    originPath: path.join(skillDir, ".clawhub", "origin.json"),
    lockPath: path.join(workspaceDir, ".clawhub", "lock.json"),
  });
}

const origin = {
  version: 1 as const,
  registry: "https://clawhub.ai",
  slug: "canary",
  installedVersion: "1.0.0",
  installedAt: 1,
};

it("publishes skill origin before a queued authority retirement", async () => {
  await withTrackingPaths(async ({ workspaceDir, skillDir, originPath }) => {
    let current = true;
    let checks = 0;
    const currentAtPublication = observePublication(originPath, () => current);

    await expect(
      recordClawHubSkillInstall({
        workspaceDir,
        skillDir,
        origin,
        beforePersistentApply: () => {
          if (!current) {
            throw new Error("Skill write authority retired.");
          }
          if (++checks === 1) {
            queueMicrotask(() => {
              current = false;
            });
          }
        },
      }),
    ).rejects.toThrow("Skill write authority retired.");
    expect(currentAtPublication).toEqual([true]);
  });
});

it("publishes the skill lockfile before a queued authority retirement", async () => {
  await withTrackingPaths(async ({ workspaceDir, skillDir, originPath, lockPath }) => {
    let current = true;
    let retirementQueued = false;
    const currentAtPublication = observePublication(lockPath, () => current);

    await recordClawHubSkillInstall({
      workspaceDir,
      skillDir,
      origin,
      beforePersistentApply: () => {
        if (!current) {
          throw new Error("Skill write authority retired.");
        }
        if (fsSync.existsSync(originPath) && !retirementQueued) {
          retirementQueued = true;
          queueMicrotask(() => {
            current = false;
          });
        }
      },
    });
    expect(retirementQueued).toBe(true);
    expect(currentAtPublication).toEqual([true]);
  });
});
