import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { cleanupManagedHandoffTempDirs } from "./update-managed-service-handoff-temp.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["relative", "outside", "escaped", "symlink"])(
  "refuses %s cleanup before deleting any directory",
  async (kind) => {
    const root = tempDirs.make("handoff-cleanup-owned-");
    const outside = tempDirs.make("handoff-cleanup-outside-");
    const owned = path.join(root, "artifact");
    await fs.mkdir(owned);
    const canary = path.join(outside, "canary");
    await fs.writeFile(canary, "preserve");
    let refused = kind === "relative" ? "." : outside;
    if (kind === "escaped") {
      refused = `${root}${path.sep}..${path.sep}${path.basename(outside)}`;
    } else if (kind === "symlink") {
      refused = path.join(root, "outside-link");
      await fs.symlink(outside, refused, "junction");
    }
    await expect(cleanupManagedHandoffTempDirs([owned, refused], root)).rejects.toThrow("Refusing");
    expect(await fs.readFile(canary, "utf8")).toBe("preserve");
    expect((await fs.stat(owned)).isDirectory()).toBe(true);
  },
);

it("removes an owned artifact and accepts an already removed artifact", async () => {
  const root = tempDirs.make("handoff-cleanup-owned-");
  const artifact = path.join(root, "artifact");
  await fs.mkdir(artifact);
  await cleanupManagedHandoffTempDirs([artifact, path.join(root, "already-gone")], root);
  await expect(fs.stat(artifact)).rejects.toMatchObject({ code: "ENOENT" });
});
