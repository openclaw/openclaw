import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  recordClawHubSkillInstall,
  replaceClawHubSkillLockEntryExpected,
  untrackClawHubSkill,
} from "./clawhub-store.js";

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
  "refuses skill %s publication after authority retires during staging",
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
    await expect(recording).rejects.toThrow("Skill write authority retired.");
    expect({ retirementQueued, currentAtPublication }).toEqual({
      retirementQueued: true,
      currentAtPublication: [],
    });
  },
);

it.each(["rename", "copy-fallback"])(
  "installs, untracks and restores tracking without synchronous filesystem writes (%s)",
  async (publication) => {
    const workspaceDir = tempDirs.make("clawhub-store-async-");
    const synchronousWrites = ["writeSync", "writeFileSync", "fsyncSync", "renameSync"] as const;
    const calls = synchronousWrites.map((name) => vi.spyOn(fsSync, name));
    await recordClawHubSkillInstall({
      workspaceDir,
      skillDir: path.join(workspaceDir, "skills", "canary"),
      origin: {
        version: 1,
        registry: "https://clawhub.ai",
        slug: "canary",
        installedVersion: "1.0.0",
        installedAt: 1,
      },
      beforePersistentApply: () => undefined,
    });
    const lockPath = path.join(workspaceDir, ".clawhub/lock.json");
    const installed = await fs.readFile(lockPath, "utf8");
    const restore = await untrackClawHubSkill(workspaceDir, "canary", () => undefined);
    expect(JSON.parse(await fs.readFile(lockPath, "utf8")).skills).toEqual({});
    await restore();
    expect(await fs.readFile(lockPath, "utf8")).toBe(installed);
    const expected = JSON.parse(installed).skills.canary;
    const replacement = { ...expected, version: "2.0.0" };
    if (publication === "copy-fallback") {
      const refused = Object.assign(new Error("rename refused"), { code: "EPERM" });
      vi.spyOn(fs, "rename").mockRejectedValueOnce(refused);
      vi.spyOn(fsSync, "renameSync").mockImplementationOnce(() => {
        throw refused;
      });
    }
    await replaceClawHubSkillLockEntryExpected({
      workspaceDir,
      slug: "canary",
      expected,
      replacement,
      assertCurrent: () => undefined,
    });
    expect(JSON.parse(await fs.readFile(lockPath, "utf8")).skills.canary).toEqual(replacement);
    expect(
      Object.fromEntries(
        calls.map((spy, index) => [synchronousWrites[index], spy.mock.calls.length]),
      ),
    ).toEqual({ writeSync: 0, writeFileSync: 0, fsyncSync: 0, renameSync: 0 });
  },
);

it("stops permission-error fallback after its removal loses authority", async () => {
  const workspaceDir = tempDirs.make("clawhub-store-fallback-authority-");
  await recordClawHubSkillInstall({
    workspaceDir,
    skillDir: path.join(workspaceDir, "skills", "canary"),
    origin: {
      version: 1,
      registry: "https://clawhub.ai",
      slug: "canary",
      installedVersion: "1.0.0",
      installedAt: 1,
    },
    beforePersistentApply: () => undefined,
  });
  const lockPath = path.join(workspaceDir, ".clawhub/lock.json");
  let current = true;
  const destinationOpens: boolean[] = [];
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
    if (String(target) === lockPath) {
      destinationOpens.push(current);
    }
    return await open(target, flags, mode);
  });
  const rm = fs.rm.bind(fs);
  vi.spyOn(fs, "rename").mockRejectedValueOnce(
    Object.assign(new Error("rename refused"), { code: "EPERM" }),
  );
  vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
    await rm(target, options);
    if (String(target) === lockPath) {
      current = false;
    }
  });
  await expect(
    untrackClawHubSkill(workspaceDir, "canary", () => {
      if (!current) {
        throw new Error("Skill write authority retired.");
      }
    }),
  ).rejects.toThrow("Skill write authority retired.");
  expect(current).toBe(false);
  expect(destinationOpens).not.toContain(false);
  await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
});
