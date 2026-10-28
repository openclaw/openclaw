import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { configureFsSafeNative, getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { prepareVerifiedSqliteFile } from "./sqlite-snapshot.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const nativeConfig = getFsSafeNativeConfig();
afterEach(() => {
  vi.restoreAllMocks();
  configureFsSafeNative(nativeConfig);
});

async function prepare() {
  const directory = directories.make("sqlite-prepared-volume-");
  const sourcePath = path.join(directory, "source.sqlite");
  const targetPath = path.join(directory, "restored.sqlite");
  const db = new DatabaseSync(sourcePath);
  try {
    db.exec("CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('retained');");
  } finally {
    db.close();
  }
  const bytes = await fs.readFile(sourcePath);
  const prepared = await prepareVerifiedSqliteFile({
    sourcePath,
    targetPath,
    sourceIdentity: await fs.lstat(sourcePath, { bigint: true }),
    expectedContent: {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
    },
    requireAtomicPublication: true,
  });
  return { sourcePath, targetPath, bytes, prepared };
}

it("publishes a prepared SQLite image when overlay file and directory device metadata differ", async () => {
  const { sourcePath, targetPath, bytes, prepared } = await prepare();
  const lstat = fs.lstat.bind(fs);
  let projected = false;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    const stat = await lstat(...args);
    if (
      !projected &&
      String(args[0]) === path.dirname(prepared.path) &&
      typeof stat.dev === "bigint"
    ) {
      stat.dev += 1n;
      projected = true;
    }
    return stat;
  });

  await prepared.publish();
  expect(projected).toBe(true);
  expect(await fs.readFile(targetPath)).toEqual(bytes);
  expect(await fs.readFile(sourcePath)).toEqual(bytes);
});

it("retains prepared bytes without copying when the filesystem refuses an atomic hard link", async () => {
  configureFsSafeNative({ mode: "off" });
  const { targetPath, bytes, prepared } = await prepare();
  const link = fs.link.bind(fs);
  vi.spyOn(fs, "link").mockImplementation(async (source, target) => {
    if (String(target) === targetPath) {
      throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    }
    return link(source, target);
  });

  await expect(prepared.publish()).rejects.toThrow(
    "Atomic SQLite publication requires hard-link support",
  );
  await expect(fs.access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(prepared.path)).toEqual(bytes);
});
