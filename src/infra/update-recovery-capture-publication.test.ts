import fs from "node:fs/promises";
import path from "node:path";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as durability from "./directory-durability.js";
import { FsSafeError } from "./fs-safe.js";
import { publishUpdateRecoveryCaptureFile } from "./update-recovery-capture-publication.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const nativeConfig = getFsSafeNativeConfig();
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative(nativeConfig);
});

async function fixture() {
  const directory = dirs.make("capture-publication-");
  const sourcePath = path.join(directory, "source");
  const targetPath = path.join(directory, "target");
  await fs.writeFile(sourcePath, "retained original", { mode: 0o600 });
  const expectedSourceIdentity = await fs.lstat(sourcePath, { bigint: true });
  const unsupported = new FsSafeError("helper-unavailable", "RENAME_NOREPLACE: EINVAL", {
    details: { capability: "rename-noreplace" },
  });
  const publish = durability.publishFileExclusive;
  vi.spyOn(durability, "publishFileExclusive").mockImplementation(async (params) => {
    if (params.strategy === "rename-noreplace") {
      throw unsupported;
    }
    return publish(params);
  });
  // Exercise the portable publisher directly, including its real exclusive-copy path.
  configureFsSafeNative({ mode: "off" });
  return {
    sourcePath,
    targetPath,
    unsupported,
    publish: () =>
      publishUpdateRecoveryCaptureFile({
        sourcePath,
        targetPath,
        expectedSourceIdentity,
        assertCurrent() {},
        onSyncFailure: "preserve",
      }),
  };
}

it.each(["hardlink", "exclusive copy"])("retains one readable capture using %s", async (mode) => {
  const f = await fixture();
  if (mode === "exclusive copy") {
    vi.spyOn(fs, "link").mockRejectedValue(
      Object.assign(new Error("hardlinks unsupported"), { code: "EPERM" }),
    );
  }
  await f.publish();
  expect(await fs.readFile(f.targetPath, "utf8")).toBe("retained original");
  expect((await fs.lstat(f.targetPath)).nlink).toBe(1);
  await expect(fs.lstat(f.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves a competing capture and its unpublished source", async () => {
  const f = await fixture();
  await fs.writeFile(f.targetPath, "competing capture");
  await expect(f.publish()).rejects.toMatchObject({ code: "EEXIST" });
  expect(await fs.readFile(f.sourcePath, "utf8")).toBe("retained original");
  expect(await fs.readFile(f.targetPath, "utf8")).toBe("competing capture");
});

it("keeps native require fail-closed before publication", async () => {
  const f = await fixture();
  configureFsSafeNative({ mode: "require" });
  await expect(f.publish()).rejects.toBe(f.unsupported);
  expect(await fs.readFile(f.sourcePath, "utf8")).toBe("retained original");
  await expect(fs.lstat(f.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
});
