import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathExists as dependencyPathExists } from "@openclaw/fs-safe/advanced";
import { afterEach, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { pathExists } from "./fs-safe.js";

const tempDirs = createTrackedTempDirs();
afterEach(async () => {
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

it.runIf(process.platform !== "win32")(
  "follows links and treats unavailable paths as absent",
  async () => {
    const dir = await tempDirs.make("path-exists-");
    const target = path.join(dir, "target");
    const link = path.join(dir, "link");
    await fs.writeFile(target, "synthetic");
    await fs.symlink(target, link);
    expect(await pathExists(dir)).toBe(true);
    expect(await pathExists(link)).toBe(true);
    await fs.unlink(target);
    expect(await pathExists(link)).toBe(false);
    vi.spyOn(fs, "stat").mockRejectedValue(new Error("filesystem unavailable"));
    expect(await pathExists(dir)).toBe(false);
  },
);

it.each([
  "\\\\?\\C:\\",
  "//?/c:/",
  "\\\\.\\C:\\",
  "\\\\?\\C:\\folder\\..",
  "//?/c:/folder/..",
  "\\\\.\\C:\\folder\\..",
  "\\\\?\\C:\\name:stream\\..",
  "\\\\?\\C:",
  "\\\\?\\C:\\folder",
  "\\\\?\\UNC\\host\\share\\",
  "C:\\",
])("preserves the dependency's Windows filesystem spelling for %s", async (input) => {
  const stats = await fs.stat(import.meta.filename);
  const windowsResolve = path.win32.resolve;
  const synchronous = vi.spyOn(fsSync, "statSync").mockReturnValue(stats);
  const asynchronous = vi.spyOn(fs, "stat").mockResolvedValue(stats);
  const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const resolve = vi.spyOn(path, "resolve").mockImplementation(windowsResolve);
  try {
    expect(await dependencyPathExists(input)).toBe(true);
    expect(await pathExists(input)).toBe(true);
    expect(asynchronous).toHaveBeenCalledExactlyOnceWith(synchronous.mock.calls[0]![0]);
  } finally {
    resolve.mockRestore();
    platform.mockRestore();
  }
});
