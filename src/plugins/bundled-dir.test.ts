import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as openclawRoot from "../infra/openclaw-root.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";

const tempDirs: string[] = [];
const originalBundledDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalVitest = process.env.VITEST;

function makeRepoRoot(prefix: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(repoRoot);
  return repoRoot;
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalBundledDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledDir;
  }
  if (originalVitest === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = originalVitest;
  }
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveBundledPluginsDir", () => {
  it("prefers the staged runtime bundled plugin tree from the package root", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-dir-runtime-");
    fs.mkdirSync(path.join(repoRoot, "dist-runtime", "extensions"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "dist", "extensions"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      `${JSON.stringify({ name: "openclaw" }, null, 2)}\n`,
      "utf8",
    );

    vi.spyOn(openclawRoot, "resolveOpenClawPackageRootSync").mockImplementation((opts) => {
      if (opts.moduleUrl) {
        return repoRoot;
      }
      return null;
    });

    expect(fs.realpathSync(resolveBundledPluginsDir() ?? "")).toBe(
      fs.realpathSync(path.join(repoRoot, "dist-runtime", "extensions")),
    );
  });

  it("falls back to built dist/extensions in installed package roots", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-dir-dist-");
    fs.mkdirSync(path.join(repoRoot, "dist", "extensions"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      `${JSON.stringify({ name: "openclaw" }, null, 2)}\n`,
      "utf8",
    );

    vi.spyOn(openclawRoot, "resolveOpenClawPackageRootSync").mockImplementation((opts) => {
      if (opts.moduleUrl) {
        return repoRoot;
      }
      return null;
    });

    expect(fs.realpathSync(resolveBundledPluginsDir() ?? "")).toBe(
      fs.realpathSync(path.join(repoRoot, "dist", "extensions")),
    );
  });

  it("prefers source extensions under vitest to avoid stale staged plugins", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-dir-vitest-");
    fs.mkdirSync(path.join(repoRoot, "extensions"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "dist-runtime", "extensions"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "dist", "extensions"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      `${JSON.stringify({ name: "openclaw" }, null, 2)}\n`,
      "utf8",
    );

    vi.spyOn(openclawRoot, "resolveOpenClawPackageRootSync").mockImplementation((opts) => {
      if (opts.moduleUrl) {
        return repoRoot;
      }
      return null;
    });
    process.env.VITEST = "true";

    expect(fs.realpathSync(resolveBundledPluginsDir() ?? "")).toBe(
      fs.realpathSync(path.join(repoRoot, "extensions")),
    );
  });

  it("prefers source extensions in a git checkout even without vitest env", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-dir-git-");
    fs.mkdirSync(path.join(repoRoot, "extensions"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "dist-runtime", "extensions"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "dist", "extensions"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".git"), "gitdir: /tmp/fake.git\n", "utf8");
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      `${JSON.stringify({ name: "openclaw" }, null, 2)}\n`,
      "utf8",
    );

    vi.spyOn(openclawRoot, "resolveOpenClawPackageRootSync").mockImplementation((opts) => {
      if (opts.moduleUrl) {
        return repoRoot;
      }
      return null;
    });
    delete process.env.VITEST;

    expect(fs.realpathSync(resolveBundledPluginsDir() ?? "")).toBe(
      fs.realpathSync(path.join(repoRoot, "extensions")),
    );
  });

  it("does not let a cwd source checkout override an installed package root", () => {
    const installedRoot = makeRepoRoot("openclaw-bundled-dir-installed-");
    fs.mkdirSync(path.join(installedRoot, "dist", "extensions"), { recursive: true });
    fs.writeFileSync(
      path.join(installedRoot, "package.json"),
      `${JSON.stringify({ name: "openclaw" }, null, 2)}\n`,
      "utf8",
    );

    const sourceRoot = makeRepoRoot("openclaw-bundled-dir-source-");
    fs.mkdirSync(path.join(sourceRoot, "extensions"), { recursive: true });
    fs.mkdirSync(path.join(sourceRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, ".git"), "gitdir: /tmp/fake.git\n", "utf8");
    fs.writeFileSync(
      path.join(sourceRoot, "package.json"),
      `${JSON.stringify({ name: "openclaw" }, null, 2)}\n`,
      "utf8",
    );

    vi.spyOn(openclawRoot, "resolveOpenClawPackageRootSync").mockImplementation((opts) => {
      if (opts.moduleUrl) {
        return installedRoot;
      }
      if (opts.cwd) {
        return sourceRoot;
      }
      return null;
    });
    delete process.env.VITEST;

    expect(fs.realpathSync(resolveBundledPluginsDir() ?? "")).toBe(
      fs.realpathSync(path.join(installedRoot, "dist", "extensions")),
    );
  });
});
