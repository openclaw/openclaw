import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createNodeWorkerTempWorkspace } from "./node-worker-workspace-admission.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.platform === "win32").each([
  [0o770, "group-writable", true],
  [0o707, "world-writable", true],
  [0o770, "group-writable", false],
] as const)(
  "explains unsafe ancestry mode %o without changing it",
  async (mode, description, rootExists) => {
    const ancestor = tempDirs.make("node-workspace-admission-");
    const rootDir = path.join(ancestor, "state", "node-host");
    if (rootExists) {
      await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
    }
    await fs.chmod(ancestor, mode);
    const canonicalAncestor = await fs.realpath(ancestor);
    try {
      await expect(createNodeWorkerTempWorkspace({ rootDir, prefix: "probe-" })).rejects.toThrow(
        `State directory ${canonicalAncestor} is ${description} without sticky protection; run chmod go-w`,
      );
      expect((await fs.stat(ancestor)).mode & 0o777).toBe(mode);
      if (rootExists) {
        expect(await fs.readdir(rootDir)).toEqual([]);
      } else {
        await expect(fs.stat(rootDir)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await fs.chmod(ancestor, 0o700);
    }
  },
);

it.skipIf(process.platform === "win32")(
  "admits a trusted sticky ancestor and cleans the probe",
  async () => {
    const ancestor = tempDirs.make("node-workspace-admission-sticky-");
    const rootDir = path.join(ancestor, "node-host");
    await fs.mkdir(rootDir, { mode: 0o700 });
    await fs.chmod(ancestor, 0o1777);
    try {
      const probe = await createNodeWorkerTempWorkspace({ rootDir, prefix: "probe-" });
      expect((await fs.stat(probe.dir)).mode & 0o777).toBe(0o700);
      await probe.cleanup();
      expect(await fs.readdir(rootDir)).toEqual([]);
      expect((await fs.stat(ancestor)).mode & 0o7777).toBe(0o1777);
    } finally {
      await fs.chmod(ancestor, 0o700);
    }
  },
);
