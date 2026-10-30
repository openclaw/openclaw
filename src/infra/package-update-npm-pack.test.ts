import { readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareNpmGitSourceInstallSpec } from "./package-update-npm-pack.js";
import type { ResolvedGlobalInstallTarget } from "./update-global.js";

const PACK_PREFIX = "openclaw-update-pack-";

async function listPackDirs(tmpDir: string): Promise<string[]> {
  const entries = await readdir(tmpDir);
  return entries.filter((entry) => entry.startsWith(PACK_PREFIX));
}

describe("prepareNpmGitSourceInstallSpec", () => {
  const tmpDir = os.tmpdir();
  const toSweep: string[] = [];

  afterEach(async () => {
    while (toSweep.length > 0) {
      const dir = toSweep.pop();
      if (dir) {
        await rm(path.join(tmpDir, dir), { recursive: true, force: true }).catch(() => {});
      }
    }
  });

  it("removes the pack directory when the step runner throws", async () => {
    const installTarget = {
      manager: "npm",
      command: "npm",
    } as unknown as ResolvedGlobalInstallTarget;
    const before = new Set(await listPackDirs(tmpDir));

    await expect(
      prepareNpmGitSourceInstallSpec({
        installTarget,
        installSpec: "github:openclaw/openclaw",
        packageName: "openclaw",
        // Stands in for a command launch/observation failure or a throwing
        // progress callback: the step runner rejects instead of returning a step.
        runStep: async () => {
          throw new Error("simulated step-runner failure");
        },
      }),
    ).rejects.toThrow("simulated step-runner failure");

    const after = await listPackDirs(tmpDir);
    const leaked = after.filter((dir) => !before.has(dir));
    toSweep.push(...leaked);
    expect(leaked).toEqual([]);
  });
});
