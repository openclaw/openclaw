import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkPackageOwnership, formatOwnershipError } from "./update-global.js";

describe("checkPackageOwnership", () => {
  let tempDir: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ownership-"));
  });

  afterAll(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("returns ok when all files are owned by current user", async () => {
    const pkgRoot = path.join(tempDir, "case-ok");
    await fs.mkdir(pkgRoot, { recursive: true });
    await fs.writeFile(path.join(pkgRoot, "package.json"), "{}", "utf-8");
    await fs.mkdir(path.join(pkgRoot, "dist"), { recursive: true });
    await fs.writeFile(path.join(pkgRoot, "dist", "index.js"), "", "utf-8");

    const result = await checkPackageOwnership(pkgRoot);
    expect(result.ok).toBe(true);
    expect(result.foreignFiles).toEqual([]);
  });

  it("skips node_modules subdirectory", async () => {
    const pkgRoot = path.join(tempDir, "case-nm");
    await fs.mkdir(pkgRoot, { recursive: true });
    await fs.writeFile(path.join(pkgRoot, "package.json"), "{}", "utf-8");
    await fs.mkdir(path.join(pkgRoot, "node_modules", "dep"), { recursive: true });
    await fs.writeFile(path.join(pkgRoot, "node_modules", "dep", "index.js"), "", "utf-8");

    const result = await checkPackageOwnership(pkgRoot);
    expect(result.ok).toBe(true);
    expect(result.foreignFiles).toEqual([]);
  });

  it("detects foreign-owned node_modules directory itself", async () => {
    const pkgRoot = path.join(tempDir, "case-nm-foreign");
    await fs.mkdir(pkgRoot, { recursive: true });
    await fs.writeFile(path.join(pkgRoot, "package.json"), "{}", "utf-8");
    await fs.mkdir(path.join(pkgRoot, "node_modules", "dep"), { recursive: true });
    await fs.writeFile(path.join(pkgRoot, "node_modules", "dep", "index.js"), "", "utf-8");

    // Use uid=99999 so everything appears foreign-owned
    const result = await checkPackageOwnership(pkgRoot, { uid: 99999 });
    expect(result.ok).toBe(false);
    // node_modules dir itself should appear in foreignFiles
    const nmEntry = result.foreignFiles.find((f) => f.endsWith("/node_modules"));
    expect(nmEntry).toBeDefined();
  });

  it("returns ok when uid is negative (Windows/unavailable)", async () => {
    const pkgRoot = path.join(tempDir, "case-win");
    await fs.mkdir(pkgRoot, { recursive: true });

    const result = await checkPackageOwnership(pkgRoot, { uid: -1 });
    expect(result.ok).toBe(true);
  });

  it("handles non-existent directory gracefully", async () => {
    const result = await checkPackageOwnership(path.join(tempDir, "nonexistent"));
    expect(result.ok).toBe(true);
    expect(result.foreignFiles).toEqual([]);
  });
});

describe("formatOwnershipError", () => {
  it("formats a clear error message with fix command", () => {
    const msg = formatOwnershipError("/usr/lib/node_modules/openclaw", {
      ok: false,
      foreignFiles: [
        "/usr/lib/node_modules/openclaw/skills/my-skill/index.js",
        "/usr/lib/node_modules/openclaw/skills/my-skill/package.json",
      ],
      currentUid: 1000,
    });

    expect(msg).toContain("2 file(s)");
    expect(msg).toContain("not owned by the current user");
    expect(msg).toContain("uid 1000");
    expect(msg).toContain("sudo chown -R $(whoami)");
    expect(msg).toContain("/usr/lib/node_modules/openclaw");
  });

  it("truncates sample to 5 files", () => {
    const files = Array.from({ length: 8 }, (_, i) => `/pkg/file${i}.js`);
    const msg = formatOwnershipError("/pkg", {
      ok: false,
      foreignFiles: files,
      currentUid: 1000,
    });

    expect(msg).toContain("8 file(s)");
    expect(msg).toContain("... and more");
    expect(msg).not.toContain("file5.js");
  });
});
