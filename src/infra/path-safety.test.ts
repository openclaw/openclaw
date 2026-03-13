import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isWithinDir, resolveSafeBaseDir } from "./path-safety.js";

describe("path-safety", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-path-safety-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("resolves safe base dir with trailing separator", () => {
    const base = resolveSafeBaseDir(tempRoot);
    expect(base.endsWith(path.sep)).toBe(true);
  });

  it("checks directory containment", async () => {
    const demoDir = path.join(tempRoot, "demo");
    await fs.mkdir(demoDir, { recursive: true });

    expect(isWithinDir(demoDir, demoDir)).toBe(true);
    expect(isWithinDir(demoDir, path.join(demoDir, "sub", "file.txt"))).toBe(true);
    expect(isWithinDir(demoDir, path.join(tempRoot, "escape.txt"))).toBe(false);
  });
});
