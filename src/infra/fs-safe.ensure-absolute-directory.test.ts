import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { ensureAbsoluteDirectory } from "./fs-safe.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("ensureAbsoluteDirectory", () => {
  it("accepts a symlink that resolves to a directory", async () => {
    const root = await tempDirs.make("openclaw-fs-safe-symlink-dir-");
    const targetDir = path.join(root, "target");
    const linkDir = path.join(root, "memory");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.symlink(targetDir, linkDir);

    const result = await ensureAbsoluteDirectory(linkDir, { scopeLabel: "workspace directory" });

    expect(result).toEqual({ ok: true, path: linkDir });
  });
});
