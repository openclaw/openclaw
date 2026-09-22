import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { copyPackagePathEntry } from "./package-update-filesystem.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.runIf(process.platform === "darwin").each([0o700, 0o755])(
  "preserves symlink mode %s without following its target",
  async (mode) => {
    const root = dirs.make("package-launcher-mode-");
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const target = path.join(root, "target");
    await fs.writeFile(target, "target contents", { mode: 0o640 });
    await fs.symlink("target", source);
    await fs.lchmod(source, mode);
    const targetStat = await fs.stat(target);
    const symlink = fs.symlink.bind(fs);
    vi.spyOn(fs, "symlink").mockImplementation(async (...args) => {
      await symlink(...args);
      await fs.lchmod(args[1], mode === 0o700 ? 0o755 : 0o700);
    });

    await copyPackagePathEntry(source, destination);
    expect(await fs.readlink(destination)).toBe("target");
    expect((await fs.lstat(destination)).mode).toBe((await fs.lstat(source)).mode);
    expect((await fs.stat(target)).mode).toBe(targetStat.mode);
    expect(await fs.readFile(target, "utf8")).toBe("target contents");
    await fs.unlink(target);
    await copyPackagePathEntry(source, destination);
    expect((await fs.lstat(destination)).mode).toBe((await fs.lstat(source)).mode);
    expect(await fs.readlink(destination)).toBe("target");
  },
);

it.runIf(process.platform === "darwin")(
  "keeps the live launcher intact when symlink metadata cannot be preserved",
  async () => {
    const root = dirs.make("package-launcher-metadata-");
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    await fs.symlink("missing", source);
    await fs.writeFile(destination, "live launcher");
    vi.spyOn(fs, "lchmod").mockRejectedValueOnce(new Error("link mode denied"));

    await expect(copyPackagePathEntry(source, destination)).rejects.toThrow("link mode denied");
    expect(await fs.readFile(destination, "utf8")).toBe("live launcher");
    expect((await fs.readdir(root)).toSorted()).toEqual(["destination", "source"]);
  },
);

it("keeps the live launcher intact when its replacement copy is interrupted", async () => {
  const root = dirs.make("package-launcher-copy-");
  const source = path.join(root, "retained-launcher");
  const destination = path.join(root, "live-launcher");
  await fs.writeFile(source, "previous launcher\n");
  await fs.writeFile(destination, "candidate launcher\n");
  const copy = vi.spyOn(fs, "copyFile").mockImplementationOnce(async (_source, staged) => {
    await fs.writeFile(staged, "partial launcher");
    throw new Error("interrupted launcher copy");
  });

  await expect(copyPackagePathEntry(source, destination)).rejects.toThrow(
    "interrupted launcher copy",
  );
  expect(await fs.readFile(destination, "utf8")).toBe("candidate launcher\n");
  expect((await fs.readdir(root)).toSorted()).toEqual(["live-launcher", "retained-launcher"]);

  copy.mockRestore();
  await copyPackagePathEntry(source, destination);
  expect(await fs.readFile(destination, "utf8")).toBe("previous launcher\n");
});
