import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBundledPluginsDir } from "./bundled-dir.js";

const tempDirs: string[] = [];
const originalBundledDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalVitest = process.env.VITEST;
const originalArgv1 = process.argv[1];

function makeRepoRoot(prefix: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(repoRoot);
  return repoRoot;
}

function createOpenClawRoot(params: {
  prefix: string;
  hasExtensions?: boolean;
  hasSrc?: boolean;
  hasDistRuntimeExtensions?: boolean;
  hasDistExtensions?: boolean;
  hasGitCheckout?: boolean;
}) {
  const repoRoot = makeRepoRoot(params.prefix);
  if (params.hasExtensions) {
    fs.mkdirSync(path.join(repoRoot, "extensions"), { recursive: true });
  }
  if (params.hasSrc) {
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  }
  if (params.hasDistRuntimeExtensions) {
    fs.mkdirSync(path.join(repoRoot, "dist-runtime", "extensions"), { recursive: true });
  }
  if (params.hasDistExtensions) {
    fs.mkdirSync(path.join(repoRoot, "dist", "extensions"), { recursive: true });
  }
  if (params.hasGitCheckout) {
    fs.writeFileSync(path.join(repoRoot, ".git"), "gitdir: /tmp/fake.git\n", "utf8");
  }
  fs.writeFileSync(
    path.join(repoRoot, "package.json"),
    `${JSON.stringify({ name: "openclaw" }, null, 2)}\n`,
    "utf8",
  );
  return repoRoot;
}

function expectResolvedBundledDir(params: {
  cwd: string;
  expectedDir: string;
  argv1?: string;
  bundledDirOverride?: string;
  vitest?: string;
}) {
  vi.spyOn(process, "cwd").mockReturnValue(params.cwd);
  process.argv[1] = params.argv1 ?? "/usr/bin/env";
  if (params.vitest === undefined) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = params.vitest;
  }
  if (params.bundledDirOverride === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = params.bundledDirOverride;
  }

  expect(fs.realpathSync(resolveBundledPluginsDir() ?? "")).toBe(
    fs.realpathSync(params.expectedDir),
  );
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
  process.argv[1] = originalArgv1;
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveBundledPluginsDir", () => {
  it.each([
    [
      "prefers the staged runtime bundled plugin tree from the package root",
      {
        prefix: "openclaw-bundled-dir-runtime-",
        hasDistRuntimeExtensions: true,
        hasDistExtensions: true,
      },
      {
        expectedRelativeDir: path.join("dist-runtime", "extensions"),
      },
    ],
    [
      "falls back to built dist/extensions in installed package roots",
      {
        prefix: "openclaw-bundled-dir-dist-",
        hasDistExtensions: true,
      },
      {
        expectedRelativeDir: path.join("dist", "extensions"),
      },
    ],
    [
      "prefers source extensions under vitest to avoid stale staged plugins",
      {
        prefix: "openclaw-bundled-dir-vitest-",
        hasExtensions: true,
        hasDistRuntimeExtensions: true,
        hasDistExtensions: true,
      },
      {
        expectedRelativeDir: "extensions",
        vitest: "true",
      },
    ],
    [
      "prefers source extensions in a git checkout even without vitest env",
      {
        prefix: "openclaw-bundled-dir-git-",
        hasExtensions: true,
        hasSrc: true,
        hasDistRuntimeExtensions: true,
        hasDistExtensions: true,
        hasGitCheckout: true,
      },
      {
        expectedRelativeDir: "extensions",
      },
    ],
  ] as const)("%s", (_name, layout, expectation) => {
    const repoRoot = createOpenClawRoot(layout);
    expectResolvedBundledDir({
      cwd: repoRoot,
      expectedDir: path.join(repoRoot, expectation.expectedRelativeDir),
      vitest: "vitest" in expectation ? expectation.vitest : undefined,
    });
  });

  it("prefers the running CLI package root over an unrelated cwd checkout", () => {
    const installedRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-installed-",
      hasDistExtensions: true,
    });
    const cwdRepoRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-cwd-",
      hasExtensions: true,
      hasSrc: true,
      hasGitCheckout: true,
    });

    expectResolvedBundledDir({
      cwd: cwdRepoRoot,
      argv1: path.join(installedRoot, "openclaw.mjs"),
      expectedDir: path.join(installedRoot, "dist", "extensions"),
    });
  });

  it("falls back to the running installed package when the override path is stale", () => {
    const installedRoot = createOpenClawRoot({
      prefix: "openclaw-bundled-dir-override-",
      hasDistExtensions: true,
    });

    expectResolvedBundledDir({
      cwd: process.cwd(),
      argv1: path.join(installedRoot, "openclaw.mjs"),
      bundledDirOverride: path.join(installedRoot, "missing-extensions"),
      expectedDir: path.join(installedRoot, "dist", "extensions"),
    });
  });
});
