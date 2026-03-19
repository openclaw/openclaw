import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBundledPluginsDir } from "./bundled-dir.js";

const tempDirs: string[] = [];
const originalCwd = process.cwd();
const originalBundledDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalVitest = process.env.VITEST;

function makeRepoRoot(prefix: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(repoRoot);
  return repoRoot;
}

afterEach(() => {
  process.chdir(originalCwd);
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

    process.chdir(repoRoot);

    expect(fs.realpathSync(resolveBundledPluginsDir() ?? "")).toBe(
      fs.realpathSync(path.join(repoRoot, "dist-runtime", "extensions")),
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

    process.chdir(repoRoot);
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

    process.chdir(repoRoot);
    delete process.env.VITEST;

    expect(fs.realpathSync(resolveBundledPluginsDir() ?? "")).toBe(
      fs.realpathSync(path.join(repoRoot, "extensions")),
    );
  });
});
