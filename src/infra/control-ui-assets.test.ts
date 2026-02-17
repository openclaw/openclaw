import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  resolveControlUiDistIndexHealth,
  resolveControlUiDistIndexPath,
  resolveControlUiDistIndexPathForRoot,
  resolveControlUiRepoRoot,
  resolveControlUiRootOverrideSync,
  resolveControlUiRootSync,
} from "./control-ui-assets.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";

/** Try to create a symlink; returns false if the OS denies it (Windows CI without Developer Mode). */
async function trySymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath);
    return true;
  } catch {
    return false;
  }
}

async function canonicalPath(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

describe("control UI assets helpers", () => {
  let fixtureRoot = "";
  let caseId = 0;

  async function withTempDir<T>(fn: (tmp: string) => Promise<T>): Promise<T> {
    const tmp = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(tmp, { recursive: true });
    return await fn(tmp);
  }

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("resolves repo root from src argv1", async () => {
    await withTempDir(async (tmp) => {
      await fs.mkdir(path.join(tmp, "ui"), { recursive: true });
      await fs.writeFile(path.join(tmp, "ui", "vite.config.ts"), "export {};\n");
      await fs.writeFile(path.join(tmp, "package.json"), "{}\n");
      await fs.mkdir(path.join(tmp, "src"), { recursive: true });
      await fs.writeFile(path.join(tmp, "src", "index.ts"), "export {};\n");

      expect(resolveControlUiRepoRoot(path.join(tmp, "src", "index.ts"))).toBe(tmp);
    });
  });

  it("resolves repo root from dist argv1", async () => {
    await withTempDir(async (tmp) => {
      await fs.mkdir(path.join(tmp, "ui"), { recursive: true });
      await fs.writeFile(path.join(tmp, "ui", "vite.config.ts"), "export {};\n");
      await fs.writeFile(path.join(tmp, "package.json"), "{}\n");
      await fs.mkdir(path.join(tmp, "dist"), { recursive: true });
      await fs.writeFile(path.join(tmp, "dist", "index.js"), "export {};\n");

      expect(resolveControlUiRepoRoot(path.join(tmp, "dist", "index.js"))).toBe(tmp);
    });
  });

  it("resolves dist control-ui index path for dist argv1", async () => {
    const argv1 = path.resolve("/tmp", "pkg", "dist", "index.js");
    const distDir = path.dirname(argv1);
    expect(await resolveControlUiDistIndexPath(argv1)).toBe(
      path.join(distDir, "control-ui", "index.html"),
    );
  });

  it("resolves control-ui root for dist bundle argv1", async () => {
    await withTempDir(async (tmp) => {
      await fs.mkdir(path.join(tmp, "dist", "control-ui"), { recursive: true });
      await fs.writeFile(path.join(tmp, "dist", "bundle.js"), "export {};\n");
      await fs.writeFile(path.join(tmp, "dist", "control-ui", "index.html"), "<html></html>\n");

      expect(resolveControlUiRootSync({ argv1: path.join(tmp, "dist", "bundle.js") })).toBe(
        path.join(tmp, "dist", "control-ui"),
      );
    });
  });

  it("resolves control-ui root for dist/gateway bundle argv1", async () => {
    await withTempDir(async (tmp) => {
      await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "openclaw" }));
      await fs.mkdir(path.join(tmp, "dist", "gateway"), { recursive: true });
      await fs.mkdir(path.join(tmp, "dist", "control-ui"), { recursive: true });
      await fs.writeFile(path.join(tmp, "dist", "gateway", "control-ui.js"), "export {};\n");
      await fs.writeFile(path.join(tmp, "dist", "control-ui", "index.html"), "<html></html>\n");

      expect(
        resolveControlUiRootSync({ argv1: path.join(tmp, "dist", "gateway", "control-ui.js") }),
      ).toBe(path.join(tmp, "dist", "control-ui"));
    });
  });

  it("resolves control-ui root from override directory or index.html", async () => {
    await withTempDir(async (tmp) => {
      const uiDir = path.join(tmp, "dist", "control-ui");
      await fs.mkdir(uiDir, { recursive: true });
      await fs.writeFile(path.join(uiDir, "index.html"), "<html></html>\n");

      expect(resolveControlUiRootOverrideSync(uiDir)).toBe(uiDir);
      expect(resolveControlUiRootOverrideSync(path.join(uiDir, "index.html"))).toBe(uiDir);
      expect(resolveControlUiRootOverrideSync(path.join(uiDir, "missing.html"))).toBeNull();
    });
  });

  it("resolves dist control-ui index path from package root argv1", async () => {
    await withTempDir(async (tmp) => {
      await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "openclaw" }));
      await fs.writeFile(path.join(tmp, "openclaw.mjs"), "export {};\n");
      await fs.mkdir(path.join(tmp, "dist", "control-ui"), { recursive: true });
      await fs.writeFile(path.join(tmp, "dist", "control-ui", "index.html"), "<html></html>\n");

      expect(await resolveControlUiDistIndexPath(path.join(tmp, "openclaw.mjs"))).toBe(
        path.join(tmp, "dist", "control-ui", "index.html"),
      );
    });
  });

  it("resolves control-ui root for package entrypoint argv1", async () => {
    await withTempDir(async (tmp) => {
      await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "openclaw" }));
      await fs.writeFile(path.join(tmp, "openclaw.mjs"), "export {};\n");
      await fs.mkdir(path.join(tmp, "dist", "control-ui"), { recursive: true });
      await fs.writeFile(path.join(tmp, "dist", "control-ui", "index.html"), "<html></html>\n");

      expect(resolveControlUiRootSync({ argv1: path.join(tmp, "openclaw.mjs") })).toBe(
        path.join(tmp, "dist", "control-ui"),
      );
    });
  });

  it("resolves dist control-ui index path from .bin argv1", async () => {
    await withTempDir(async (tmp) => {
      const binDir = path.join(tmp, "node_modules", ".bin");
      const pkgRoot = path.join(tmp, "node_modules", "openclaw");
      await fs.mkdir(binDir, { recursive: true });
      await fs.mkdir(path.join(pkgRoot, "dist", "control-ui"), { recursive: true });
      await fs.writeFile(path.join(binDir, "openclaw"), "#!/usr/bin/env node\n");
      await fs.writeFile(path.join(pkgRoot, "package.json"), JSON.stringify({ name: "openclaw" }));
      await fs.writeFile(path.join(pkgRoot, "dist", "control-ui", "index.html"), "<html></html>\n");

      expect(await resolveControlUiDistIndexPath(path.join(binDir, "openclaw"))).toBe(
        path.join(pkgRoot, "dist", "control-ui", "index.html"),
      );
    });
  });

  it("resolves via fallback when package root resolution fails but package name matches", async () => {
    await withTempDir(async (tmp) => {
      // Package named "openclaw" but resolveOpenClawPackageRoot failed for other reasons
      await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "openclaw" }));
      await fs.writeFile(path.join(tmp, "openclaw.mjs"), "export {};\n");
      await fs.mkdir(path.join(tmp, "dist", "control-ui"), { recursive: true });
      await fs.writeFile(path.join(tmp, "dist", "control-ui", "index.html"), "<html></html>\n");

      expect(await resolveControlUiDistIndexPath(path.join(tmp, "openclaw.mjs"))).toBe(
        path.join(tmp, "dist", "control-ui", "index.html"),
      );
    });
  });

  it("returns null when package name does not match openclaw", async () => {
    await withTempDir(async (tmp) => {
      // Package with different name should not be resolved
      await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "malicious-pkg" }));
      await fs.writeFile(path.join(tmp, "index.mjs"), "export {};\n");
      await fs.mkdir(path.join(tmp, "dist", "control-ui"), { recursive: true });
      await fs.writeFile(path.join(tmp, "dist", "control-ui", "index.html"), "<html></html>\n");

      expect(await resolveControlUiDistIndexPath(path.join(tmp, "index.mjs"))).toBeNull();
    });
  });

  it("returns null when no control-ui assets exist", async () => {
    await withTempDir(async (tmp) => {
      // Just a package.json, no dist/control-ui
      await fs.writeFile(path.join(tmp, "package.json"), JSON.stringify({ name: "some-pkg" }));
      await fs.writeFile(path.join(tmp, "index.mjs"), "export {};\n");

      expect(await resolveControlUiDistIndexPath(path.join(tmp, "index.mjs"))).toBeNull();
    });
  });

  it("reports health for existing control-ui assets at a known root", async () => {
    await withTempDir(async (tmp) => {
      const indexPath = resolveControlUiDistIndexPathForRoot(tmp);
      await fs.mkdir(path.dirname(indexPath), { recursive: true });
      await fs.writeFile(indexPath, "<html></html>\n");

      await expect(resolveControlUiDistIndexHealth({ root: tmp })).resolves.toEqual({
        indexPath,
        exists: true,
      });
    });
  });

  it("reports health for missing control-ui assets at a known root", async () => {
    await withTempDir(async (tmp) => {
      const indexPath = resolveControlUiDistIndexPathForRoot(tmp);
      await expect(resolveControlUiDistIndexHealth({ root: tmp })).resolves.toEqual({
        indexPath,
        exists: false,
      });
    });
  });

  it("resolves control-ui root when argv1 is a symlink (nvm scenario)", async () => {
    await withTempDir(async (tmp) => {
      const realPkg = path.join(tmp, "real-pkg");
      const bin = path.join(tmp, "bin");
      await fs.mkdir(realPkg, { recursive: true });
      await fs.mkdir(bin, { recursive: true });
      await fs.writeFile(path.join(realPkg, "package.json"), JSON.stringify({ name: "openclaw" }));
      await fs.writeFile(path.join(realPkg, "openclaw.mjs"), "export {};\n");
      await fs.mkdir(path.join(realPkg, "dist", "control-ui"), { recursive: true });
      await fs.writeFile(path.join(realPkg, "dist", "control-ui", "index.html"), "<html></html>\n");
      const ok = await trySymlink(
        path.join("..", "real-pkg", "openclaw.mjs"),
        path.join(bin, "openclaw"),
      );
      if (!ok) {
        return; // symlinks not supported (Windows CI)
      }

      const resolvedRoot = resolveControlUiRootSync({ argv1: path.join(bin, "openclaw") });
      expect(resolvedRoot).not.toBeNull();
      expect(await canonicalPath(resolvedRoot ?? "")).toBe(
        await canonicalPath(path.join(realPkg, "dist", "control-ui")),
      );
    });
  });

  it("resolves package root via symlinked argv1", async () => {
    await withTempDir(async (tmp) => {
      const realPkg = path.join(tmp, "real-pkg");
      const bin = path.join(tmp, "bin");
      await fs.mkdir(realPkg, { recursive: true });
      await fs.mkdir(bin, { recursive: true });
      await fs.writeFile(path.join(realPkg, "package.json"), JSON.stringify({ name: "openclaw" }));
      await fs.writeFile(path.join(realPkg, "openclaw.mjs"), "export {};\n");
      await fs.mkdir(path.join(realPkg, "dist", "control-ui"), { recursive: true });
      await fs.writeFile(path.join(realPkg, "dist", "control-ui", "index.html"), "<html></html>\n");
      const ok = await trySymlink(
        path.join("..", "real-pkg", "openclaw.mjs"),
        path.join(bin, "openclaw"),
      );
      if (!ok) {
        return; // symlinks not supported (Windows CI)
      }

      const packageRoot = await resolveOpenClawPackageRoot({ argv1: path.join(bin, "openclaw") });
      expect(packageRoot).not.toBeNull();
      expect(await canonicalPath(packageRoot ?? "")).toBe(await canonicalPath(realPkg));
    });
  });

  it("resolves dist index path via symlinked argv1 (async)", async () => {
    await withTempDir(async (tmp) => {
      const realPkg = path.join(tmp, "real-pkg");
      const bin = path.join(tmp, "bin");
      await fs.mkdir(realPkg, { recursive: true });
      await fs.mkdir(bin, { recursive: true });
      await fs.writeFile(path.join(realPkg, "package.json"), JSON.stringify({ name: "openclaw" }));
      await fs.writeFile(path.join(realPkg, "openclaw.mjs"), "export {};\n");
      await fs.mkdir(path.join(realPkg, "dist", "control-ui"), { recursive: true });
      await fs.writeFile(path.join(realPkg, "dist", "control-ui", "index.html"), "<html></html>\n");
      const ok = await trySymlink(
        path.join("..", "real-pkg", "openclaw.mjs"),
        path.join(bin, "openclaw"),
      );
      if (!ok) {
        return; // symlinks not supported (Windows CI)
      }

      const indexPath = await resolveControlUiDistIndexPath(path.join(bin, "openclaw"));
      expect(indexPath).not.toBeNull();
      expect(await canonicalPath(indexPath ?? "")).toBe(
        await canonicalPath(path.join(realPkg, "dist", "control-ui", "index.html")),
      );
    });
  });
});
