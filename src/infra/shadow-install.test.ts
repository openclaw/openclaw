import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectShadowInstall } from "./shadow-install.js";

/** Resolve symlinks so assertions match on macOS (/tmp → /private/tmp). */
async function real(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

describe("detectShadowInstall", () => {
  let fixtureRoot: string;

  beforeAll(async () => {
    fixtureRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-shadow-")));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  async function seedInstall(name: string, version = "1.0.0"): Promise<string> {
    const root = path.join(fixtureRoot, name, "node_modules", "openclaw");
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
      "utf-8",
    );
    // Create a fake dist/entry.js so the binary path resolves inside the tree.
    const distDir = path.join(root, "dist");
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(path.join(distDir, "entry.js"), "// stub\n", "utf-8");
    return root;
  }

  it("returns null when active binary is inside the updated root", async () => {
    const root = await seedInstall("same");
    // Simulate argv[1] pointing inside this root.
    const originalArgv1 = process.argv[1];
    try {
      process.argv[1] = path.join(root, "dist", "entry.js");
      const result = await detectShadowInstall({ updatedRoot: root });
      expect(result).toBeNull();
    } finally {
      process.argv[1] = originalArgv1!;
    }
  });

  it("returns a warning when active binary lives in a different root", async () => {
    const systemRoot = await seedInstall("system-global");
    const userRoot = await seedInstall("user-global");

    const originalArgv1 = process.argv[1];
    try {
      // Simulate the shell running the system-level binary...
      process.argv[1] = path.join(systemRoot, "dist", "entry.js");
      // ...while the update targeted the user-level root.
      const result = await detectShadowInstall({ updatedRoot: userRoot });
      expect(result).not.toBeNull();
      expect(result!.activeBinaryPath).toBe(await real(path.join(systemRoot, "dist", "entry.js")));
      expect(result!.activeInstallRoot).toBe(await real(systemRoot));
      expect(result!.updatedInstallRoot).toBe(await real(userRoot));
    } finally {
      process.argv[1] = originalArgv1!;
    }
  });

  it("returns null when process.argv[1] cannot be resolved", async () => {
    const root = await seedInstall("unresolvable");
    const originalArgv1 = process.argv[1];
    try {
      process.argv[1] = path.join(fixtureRoot, "nonexistent", "binary.js");
      const result = await detectShadowInstall({ updatedRoot: root });
      expect(result).toBeNull();
    } finally {
      process.argv[1] = originalArgv1!;
    }
  });

  it("returns null when argv[1] is outside any openclaw package tree", async () => {
    const root = await seedInstall("outside");
    // Create a file that's not under any openclaw package.json.
    const strayDir = path.join(fixtureRoot, "stray");
    await fs.mkdir(strayDir, { recursive: true });
    const strayBin = path.join(strayDir, "openclaw.js");
    await fs.writeFile(strayBin, "// stub\n", "utf-8");

    const originalArgv1 = process.argv[1];
    try {
      process.argv[1] = strayBin;
      const result = await detectShadowInstall({ updatedRoot: root });
      expect(result).toBeNull();
    } finally {
      process.argv[1] = originalArgv1!;
    }
  });

  it("returns null when updatedRoot is a symlink to the active root", async () => {
    const root = await seedInstall("symlinked");
    const linkPath = path.join(fixtureRoot, "symlink-to-root");
    // Remove stale symlink from prior runs (shouldn't exist, but guard).
    await fs.rm(linkPath, { force: true });
    await fs.symlink(root, linkPath);

    const originalArgv1 = process.argv[1];
    try {
      process.argv[1] = path.join(root, "dist", "entry.js");
      // updatedRoot is a symlink, but realpath resolves to the same place.
      const result = await detectShadowInstall({ updatedRoot: linkPath });
      expect(result).toBeNull();
    } finally {
      process.argv[1] = originalArgv1!;
    }
  });
});
