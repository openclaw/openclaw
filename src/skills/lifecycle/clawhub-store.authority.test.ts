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

it.each(["origin", "lockfile"] as const)(
  "publishes the skill %s before a queued authority retirement",
  async (target) => {
    const workspaceDir = tempDirs.make("clawhub-store-authority-");
    const skillDir = path.join(workspaceDir, "skills", "canary");
    const originPath = path.join(skillDir, ".clawhub/origin.json");
    const publicationPath =
      target === "origin" ? originPath : path.join(workspaceDir, ".clawhub/lock.json");
    let current = true;
    let retirementQueued = false;
    const currentAtPublication = observePublication(publicationPath, () => current);
    const recording = recordClawHubSkillInstall({
      workspaceDir,
      skillDir,
      origin: {
        version: 1,
        registry: "https://clawhub.ai",
        slug: "canary",
        installedVersion: "1.0.0",
        installedAt: 1,
      },
      beforePersistentApply: () => {
        if (!current) {
          throw new Error("Skill write authority retired.");
        }
        if (!retirementQueued && (target === "origin" || fsSync.existsSync(originPath))) {
          retirementQueued = true;
          queueMicrotask(() => {
            current = false;
          });
        }
      },
    });
    if (target === "origin") {
      await expect(recording).rejects.toThrow("Skill write authority retired.");
    } else {
      await recording;
    }
    expect({ retirementQueued, currentAtPublication }).toEqual({
      retirementQueued: true,
      currentAtPublication: [true],
    });
  },
);
