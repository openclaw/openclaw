import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveLogFile } from "./log-tail.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-log-tail-"));
  cleanupDirs.push(dir);
  return dir;
}

describe("resolveLogFile", () => {
  test("prefers the newer dated rolling file when mtimes tie", async () => {
    const dir = await createTempDir();
    const olderFile = path.join(dir, "openclaw-2026-04-02.log");
    const newerFile = path.join(dir, "openclaw-2026-04-03.log");
    const requestedFile = path.join(dir, "openclaw-2026-04-04.log");
    const sharedTime = new Date("2026-04-03T12:00:00.000Z");

    await fs.writeFile(olderFile, "older\n", "utf8");
    await fs.writeFile(newerFile, "newer\n", "utf8");
    await fs.utimes(olderFile, sharedTime, sharedTime);
    await fs.utimes(newerFile, sharedTime, sharedTime);

    await expect(resolveLogFile(requestedFile)).resolves.toBe(newerFile);
  });
});
