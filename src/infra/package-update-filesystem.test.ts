import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { copyPackagePathEntry } from "./package-update-filesystem.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

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
