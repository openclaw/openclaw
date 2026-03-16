import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBundledPluginsDir } from "./bundled-dir.js";

const tempDirs: string[] = [];
const originalCwd = process.cwd();
const originalBundledDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalWatchMode = process.env.OPENCLAW_WATCH_MODE;

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
  if (originalWatchMode === undefined) {
    delete process.env.OPENCLAW_WATCH_MODE;
  } else {
    process.env.OPENCLAW_WATCH_MODE = originalWatchMode;
  }
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveBundledPluginsDir", () => {
  it("prefers source extensions from the package root in watch mode", () => {
    const repoRoot = makeRepoRoot("openclaw-bundled-dir-watch-");
    fs.mkdirSync(path.join(repoRoot, "extensions"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "dist", "extensions"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      `${JSON.stringify({ name: "openclaw" }, null, 2)}\n`,
      "utf8",
    );

    process.chdir(repoRoot);
    process.env.OPENCLAW_WATCH_MODE = "1";

    expect(fs.realpathSync(resolveBundledPluginsDir() ?? "")).toBe(
      fs.realpathSync(path.join(repoRoot, "extensions")),
    );
  });
});
