import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { stageBundledPluginRuntime } from "../../scripts/stage-bundled-plugin-runtime.mjs";
import { discoverOpenClawPlugins } from "./discovery.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";

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
  it("stages bundled dist plugins as runtime wrappers and links plugin-local node_modules", () => {
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
    expect(fs.readFileSync(path.join(runtimePluginDir, "index.js"), "utf8")).toContain(
      "../../../dist/extensions/diffs/index.js",
    );
    expect(fs.lstatSync(path.join(runtimePluginDir, "node_modules")).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(runtimePluginDir, "node_modules"))).toBe(
      fs.realpathSync(sourcePluginNodeModulesDir),
    );
  });

  it("writes wrappers that forward plugin entry imports into canonical dist files", async () => {
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

    const runtimeEntryPath = path.join(repoRoot, "dist-runtime", "extensions", "diffs", "index.js");
    expect(fs.readFileSync(runtimeEntryPath, "utf8")).toContain(
      "../../../dist/extensions/diffs/index.js",
    );
    expect(fs.existsSync(path.join(repoRoot, "dist-runtime", "chunk-abc.js"))).toBe(false);

    const runtimeModule = await import(`${pathToFileURL(runtimeEntryPath).href}?t=${Date.now()}`);
    expect(runtimeModule.value).toBe(1);
  });

  it("copies package metadata files but symlinks other non-js plugin artifacts into the runtime overlay", () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-assets-");
    const distPluginDir = path.join(repoRoot, "dist", "extensions", "diffs");
    fs.mkdirSync(path.join(distPluginDir, "assets"), { recursive: true });
    fs.writeFileSync(
      path.join(distPluginDir, "package.json"),
      JSON.stringify(
        { name: "@openclaw/diffs", openclaw: { extensions: ["./index.js"] } },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(path.join(distPluginDir, "openclaw.plugin.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(distPluginDir, "assets", "info.txt"), "ok\n", "utf8");

    stageBundledPluginRuntime({ repoRoot });

    const runtimePackagePath = path.join(
      repoRoot,
      "dist-runtime",
      "extensions",
      "diffs",
      "package.json",
    );
    const runtimeManifestPath = path.join(
      repoRoot,
      "dist-runtime",
      "extensions",
      "diffs",
      "openclaw.plugin.json",
    );
    const runtimeAssetPath = path.join(
      repoRoot,
      "dist-runtime",
      "extensions",
      "diffs",
      "assets",
      "info.txt",
    );

    expect(fs.lstatSync(runtimePackagePath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(runtimePackagePath, "utf8")).toContain('"extensions": [');
    expect(fs.lstatSync(runtimeManifestPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(runtimeManifestPath, "utf8")).toBe("{}\n");
    expect(fs.lstatSync(runtimeAssetPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(runtimeAssetPath, "utf8")).toBe("ok\n");
  });

  it("preserves package metadata needed for bundled plugin discovery from dist-runtime", () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-discovery-");
    const distPluginDir = path.join(repoRoot, "dist", "extensions", "demo");
    const runtimeExtensionsDir = path.join(repoRoot, "dist-runtime", "extensions");
    fs.mkdirSync(distPluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(distPluginDir, "package.json"),
      JSON.stringify(
        {
          name: "@openclaw/demo",
          openclaw: {
            extensions: ["./main.js"],
            setupEntry: "./setup.js",
            startup: {
              deferConfiguredChannelFullLoadUntilAfterListen: true,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(
      path.join(distPluginDir, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "demo",
          channels: ["demo"],
          configSchema: { type: "object" },
        },
        null,
        2,
      ),
      "utf8",
    );
    fs.writeFileSync(path.join(distPluginDir, "main.js"), "export default {};\n", "utf8");
    fs.writeFileSync(path.join(distPluginDir, "setup.js"), "export default {};\n", "utf8");

    stageBundledPluginRuntime({ repoRoot });

    const env = {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: runtimeExtensionsDir,
    };
    const discovery = discoverOpenClawPlugins({
      env,
      cache: false,
    });
    const manifestRegistry = loadPluginManifestRegistry({
      env,
      cache: false,
      candidates: discovery.candidates,
      diagnostics: discovery.diagnostics,
    });
    const expectedRuntimeMainPath = fs.realpathSync(
      path.join(runtimeExtensionsDir, "demo", "main.js"),
    );
    const expectedRuntimeSetupPath = fs.realpathSync(
      path.join(runtimeExtensionsDir, "demo", "setup.js"),
    );

    expect(discovery.candidates).toHaveLength(1);
    expect(fs.realpathSync(discovery.candidates[0]?.source ?? "")).toBe(expectedRuntimeMainPath);
    expect(fs.realpathSync(discovery.candidates[0]?.setupSource ?? "")).toBe(
      expectedRuntimeSetupPath,
    );
    expect(fs.realpathSync(manifestRegistry.plugins[0]?.setupSource ?? "")).toBe(
      expectedRuntimeSetupPath,
    );
    expect(manifestRegistry.plugins[0]?.startupDeferConfiguredChannelFullLoadUntilAfterListen).toBe(
      true,
    );
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
