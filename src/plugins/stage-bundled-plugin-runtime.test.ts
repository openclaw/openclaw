import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stageBundledPluginRuntime } from "../../scripts/stage-bundled-plugin-runtime.mjs";

const tempDirs: string[] = [];

function makeRepoRoot(prefix: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(repoRoot);
  return repoRoot;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("stageBundledPluginRuntime", () => {
  it("hard-links bundled dist plugins into dist-runtime and links plugin-local node_modules", () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-");
    const distPluginDir = path.join(repoRoot, "dist", "extensions", "diffs");
    fs.mkdirSync(path.join(repoRoot, "dist"), { recursive: true });
    const sourcePluginNodeModulesDir = path.join(repoRoot, "extensions", "diffs", "node_modules");
    fs.mkdirSync(distPluginDir, { recursive: true });
    fs.mkdirSync(path.join(sourcePluginNodeModulesDir, "@pierre", "diffs"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(distPluginDir, "index.js"), "export default {}\n", "utf8");
    fs.writeFileSync(
      path.join(sourcePluginNodeModulesDir, "@pierre", "diffs", "index.js"),
      "export default {}\n",
      "utf8",
    );

    stageBundledPluginRuntime({ repoRoot });

    const runtimePluginDir = path.join(repoRoot, "dist-runtime", "extensions", "diffs");
    expect(fs.existsSync(path.join(runtimePluginDir, "index.js"))).toBe(true);
    expect(fs.statSync(path.join(runtimePluginDir, "index.js")).nlink).toBeGreaterThan(1);
    expect(fs.lstatSync(path.join(runtimePluginDir, "node_modules")).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(runtimePluginDir, "node_modules"))).toBe(
      fs.realpathSync(sourcePluginNodeModulesDir),
    );
  });

  it("hard-links top-level dist chunks so staged bundled plugins keep relative imports working", () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-chunks-");
    fs.mkdirSync(path.join(repoRoot, "dist", "extensions", "diffs"), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, "dist", "chunk-abc.js"),
      "export const value = 1;\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(repoRoot, "dist", "extensions", "diffs", "index.js"),
      "export { value } from '../../chunk-abc.js';\n",
      "utf8",
    );

    stageBundledPluginRuntime({ repoRoot });

    const runtimeChunkPath = path.join(repoRoot, "dist-runtime", "chunk-abc.js");
    expect(fs.readFileSync(runtimeChunkPath, "utf8")).toContain("value = 1");
    expect(fs.statSync(runtimeChunkPath).nlink).toBeGreaterThan(1);
    expect(
      fs.readFileSync(
        path.join(repoRoot, "dist-runtime", "extensions", "diffs", "index.js"),
        "utf8",
      ),
    ).toContain("../../chunk-abc.js");
    const distChunkStats = fs.statSync(path.join(repoRoot, "dist", "chunk-abc.js"));
    const runtimeChunkStats = fs.statSync(runtimeChunkPath);
    expect(runtimeChunkStats.ino).toBe(distChunkStats.ino);
    expect(runtimeChunkStats.dev).toBe(distChunkStats.dev);
  });

  it("removes stale runtime plugin directories that are no longer in dist", () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-stale-");
    const staleRuntimeDir = path.join(repoRoot, "dist-runtime", "extensions", "stale");
    fs.mkdirSync(staleRuntimeDir, { recursive: true });
    fs.writeFileSync(path.join(staleRuntimeDir, "index.js"), "stale\n", "utf8");
    fs.mkdirSync(path.join(repoRoot, "dist", "extensions"), { recursive: true });

    stageBundledPluginRuntime({ repoRoot });

    expect(fs.existsSync(staleRuntimeDir)).toBe(false);
  });

  it("removes dist-runtime when the built bundled plugin tree is absent", () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-missing-");
    const runtimeRoot = path.join(repoRoot, "dist-runtime", "extensions", "diffs");
    fs.mkdirSync(runtimeRoot, { recursive: true });

    stageBundledPluginRuntime({ repoRoot });

    expect(fs.existsSync(path.join(repoRoot, "dist-runtime"))).toBe(false);
  });
});
