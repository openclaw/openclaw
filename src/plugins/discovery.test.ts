import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearPluginDiscoveryCache, discoverOpenClawPlugins } from "./discovery.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugins", tempDirs);
}

const mkdirSafe = mkdirSafeDir;

function normalizePathForAssertion(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }
  return value.replace(/\\/g, "/");
}

function hasDiagnosticSourceSuffix(
  diagnostics: Array<{ source?: string }>,
  suffix: string,
): boolean {
  const normalizedSuffix = normalizePathForAssertion(suffix);
  return diagnostics.some((entry) =>
    normalizePathForAssertion(entry.source)?.endsWith(normalizedSuffix ?? suffix),
  );
}

function buildDiscoveryEnv(stateDir: string): NodeJS.ProcessEnv {
  return {
    OPENCLAW_STATE_DIR: stateDir,
    CLAWDBOT_STATE_DIR: undefined,
    OPENCLAW_HOME: undefined,
    OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
  };
}

async function discoverWithStateDir(
  stateDir: string,
  params: Parameters<typeof discoverOpenClawPlugins>[0],
) {
  return discoverOpenClawPlugins({ ...params, env: buildDiscoveryEnv(stateDir) });
}

function writePluginPackageManifest(params: {
  packageDir: string;
  packageName: string;
  extensions: string[];
}) {
  fs.writeFileSync(
    path.join(params.packageDir, "package.json"),
    JSON.stringify({
      name: params.packageName,
      openclaw: { extensions: params.extensions },
    }),
    "utf-8",
  );
}

function expectEscapesPackageDiagnostic(diagnostics: Array<{ message: string }>) {
  expect(diagnostics.some((entry) => entry.message.includes("escapes package directory"))).toBe(
    true,
  );
}

afterEach(() => {
  clearPluginDiscoveryCache();
  cleanupTrackedTempDirs(tempDirs);
});

describe("discoverOpenClawPlugins", () => {
  it("discovers global and workspace extensions", async () => {
    const stateDir = makeTempDir();
    const workspaceDir = path.join(stateDir, "workspace");

    const globalExt = path.join(stateDir, "extensions");
    mkdirSafe(globalExt);
    fs.writeFileSync(path.join(globalExt, "alpha.ts"), "export default function () {}", "utf-8");

    const workspaceExt = path.join(workspaceDir, ".openclaw", "extensions");
    mkdirSafe(workspaceExt);
    fs.writeFileSync(path.join(workspaceExt, "beta.ts"), "export default function () {}", "utf-8");

    const { candidates } = await discoverWithStateDir(stateDir, { workspaceDir });

    const ids = candidates.map((c) => c.idHint);
    expect(ids).toContain("alpha");
    expect(ids).toContain("beta");
  });

  it("resolves tilde workspace dirs against the provided env", () => {
    const stateDir = makeTempDir();
    const homeDir = makeTempDir();
    const workspaceRoot = path.join(homeDir, "workspace");
    const workspaceExt = path.join(workspaceRoot, ".openclaw", "extensions");
    mkdirSafe(workspaceExt);
    fs.writeFileSync(path.join(workspaceExt, "tilde-workspace.ts"), "export default {}", "utf-8");

    const result = discoverOpenClawPlugins({
      workspaceDir: "~/workspace",
      env: {
        ...buildDiscoveryEnv(stateDir),
        HOME: homeDir,
      },
    });

    expect(result.candidates.some((candidate) => candidate.idHint === "tilde-workspace")).toBe(
      true,
    );
  });

  it("ignores backup and disabled plugin directories in scanned roots", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions");
    mkdirSafe(globalExt);

    const backupDir = path.join(globalExt, "feishu.backup-20260222");
    mkdirSafe(backupDir);
    fs.writeFileSync(path.join(backupDir, "index.ts"), "export default function () {}", "utf-8");

    const disabledDir = path.join(globalExt, "telegram.disabled.20260222");
    mkdirSafe(disabledDir);
    fs.writeFileSync(path.join(disabledDir, "index.ts"), "export default function () {}", "utf-8");

    const bakDir = path.join(globalExt, "discord.bak");
    mkdirSafe(bakDir);
    fs.writeFileSync(path.join(bakDir, "index.ts"), "export default function () {}", "utf-8");

    const liveDir = path.join(globalExt, "live");
    mkdirSafe(liveDir);
    fs.writeFileSync(path.join(liveDir, "index.ts"), "export default function () {}", "utf-8");

    const { candidates } = await discoverWithStateDir(stateDir, {});

    const ids = candidates.map((candidate) => candidate.idHint);
    expect(ids).toContain("live");
    expect(ids).not.toContain("feishu.backup-20260222");
    expect(ids).not.toContain("telegram.disabled.20260222");
    expect(ids).not.toContain("discord.bak");
  });

  it("loads package extension packs", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "pack");
    mkdirSafe(path.join(globalExt, "src"));

    writePluginPackageManifest({
      packageDir: globalExt,
      packageName: "pack",
      extensions: ["./src/one.ts", "./src/two.ts"],
    });
    fs.writeFileSync(
      path.join(globalExt, "src", "one.ts"),
      "export default function () {}",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(globalExt, "src", "two.ts"),
      "export default function () {}",
      "utf-8",
    );

    const { candidates } = await discoverWithStateDir(stateDir, {});

    const ids = candidates.map((c) => c.idHint);
    expect(ids).toContain("pack/one");
    expect(ids).toContain("pack/two");
  });

  it("derives unscoped ids for scoped packages", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "voice-call-pack");
    mkdirSafe(path.join(globalExt, "src"));

    writePluginPackageManifest({
      packageDir: globalExt,
      packageName: "@openclaw/voice-call",
      extensions: ["./src/index.ts"],
    });
    fs.writeFileSync(
      path.join(globalExt, "src", "index.ts"),
      "export default function () {}",
      "utf-8",
    );

    const { candidates } = await discoverWithStateDir(stateDir, {});

    const ids = candidates.map((c) => c.idHint);
    expect(ids).toContain("voice-call");
  });

  it("normalizes bundled provider package ids to canonical plugin ids", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "ollama-provider-pack");
    mkdirSafe(path.join(globalExt, "src"));

    writePluginPackageManifest({
      packageDir: globalExt,
      packageName: "@openclaw/ollama-provider",
      extensions: ["./src/index.ts"],
    });
    fs.writeFileSync(
      path.join(globalExt, "src", "index.ts"),
      "export default function () {}",
      "utf-8",
    );

    const { candidates } = await discoverWithStateDir(stateDir, {});

    const ids = candidates.map((c) => c.idHint);
    expect(ids).toContain("ollama");
    expect(ids).not.toContain("ollama-provider");
  });

  it("treats configured directory paths as plugin packages", async () => {
    const stateDir = makeTempDir();
    const packDir = path.join(stateDir, "packs", "demo-plugin-dir");
    mkdirSafe(packDir);

    writePluginPackageManifest({
      packageDir: packDir,
      packageName: "@openclaw/demo-plugin-dir",
      extensions: ["./index.js"],
    });
    fs.writeFileSync(path.join(packDir, "index.js"), "module.exports = {}", "utf-8");

    const { candidates } = await discoverWithStateDir(stateDir, { extraPaths: [packDir] });

    const ids = candidates.map((c) => c.idHint);
    expect(ids).toContain("demo-plugin-dir");
  });

  it("auto-detects Codex bundles as bundle candidates", async () => {
    const stateDir = makeTempDir();
    const bundleDir = path.join(stateDir, "extensions", "sample-bundle");
    mkdirSafe(path.join(bundleDir, ".codex-plugin"));
    mkdirSafe(path.join(bundleDir, "skills"));
    fs.writeFileSync(
      path.join(bundleDir, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "Sample Bundle",
        skills: "skills",
      }),
      "utf-8",
    );

    const { candidates } = await discoverWithStateDir(stateDir, {});
    const bundle = candidates.find((candidate) => candidate.idHint === "sample-bundle");

    expect(bundle).toBeDefined();
    expect(bundle?.idHint).toBe("sample-bundle");
    expect(bundle?.format).toBe("bundle");
    expect(bundle?.bundleFormat).toBe("codex");
    expect(bundle?.source).toBe(bundleDir);
    expect(normalizePathForAssertion(bundle?.rootDir)).toBe(
      normalizePathForAssertion(fs.realpathSync(bundleDir)),
    );
  });

  it("auto-detects manifestless Claude bundles from the default layout", async () => {
    const stateDir = makeTempDir();
    const bundleDir = path.join(stateDir, "extensions", "claude-bundle");
    mkdirSafe(path.join(bundleDir, "commands"));
    fs.writeFileSync(path.join(bundleDir, "settings.json"), '{"hideThinkingBlock":true}', "utf-8");

    const { candidates } = await discoverWithStateDir(stateDir, {});
    const bundle = candidates.find((candidate) => candidate.idHint === "claude-bundle");

    expect(bundle).toBeDefined();
    expect(bundle?.format).toBe("bundle");
    expect(bundle?.bundleFormat).toBe("claude");
    expect(bundle?.source).toBe(bundleDir);
  });

  it("auto-detects Cursor bundles as bundle candidates", async () => {
    const stateDir = makeTempDir();
    const bundleDir = path.join(stateDir, "extensions", "cursor-bundle");
    mkdirSafe(path.join(bundleDir, ".cursor-plugin"));
    mkdirSafe(path.join(bundleDir, ".cursor", "commands"));
    fs.writeFileSync(
      path.join(bundleDir, ".cursor-plugin", "plugin.json"),
      JSON.stringify({
        name: "Cursor Bundle",
      }),
      "utf-8",
    );

    const { candidates } = await discoverWithStateDir(stateDir, {});
    const bundle = candidates.find((candidate) => candidate.idHint === "cursor-bundle");

    expect(bundle).toBeDefined();
    expect(bundle?.format).toBe("bundle");
    expect(bundle?.bundleFormat).toBe("cursor");
    expect(bundle?.source).toBe(bundleDir);
  });

  it("falls back to legacy index discovery when a scanned bundle sidecar is malformed", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "legacy-with-bad-bundle");
    mkdirSafe(path.join(pluginDir, ".claude-plugin"));
    fs.writeFileSync(path.join(pluginDir, "index.ts"), "export default {}", "utf-8");
    fs.writeFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), "{", "utf-8");

    const result = await discoverWithStateDir(stateDir, {});
    const legacy = result.candidates.find(
      (candidate) => candidate.idHint === "legacy-with-bad-bundle",
    );

    expect(legacy).toBeDefined();
    expect(legacy?.format).toBe("openclaw");
    expect(hasDiagnosticSourceSuffix(result.diagnostics, ".claude-plugin/plugin.json")).toBe(true);
  });

  it("falls back to legacy index discovery for configured paths with malformed bundle sidecars", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "plugins", "legacy-with-bad-bundle");
    mkdirSafe(path.join(pluginDir, ".codex-plugin"));
    fs.writeFileSync(path.join(pluginDir, "index.ts"), "export default {}", "utf-8");
    fs.writeFileSync(path.join(pluginDir, ".codex-plugin", "plugin.json"), "{", "utf-8");

    const result = await discoverWithStateDir(stateDir, {
      extraPaths: [pluginDir],
    });
    const legacy = result.candidates.find(
      (candidate) => candidate.idHint === "legacy-with-bad-bundle",
    );

    expect(legacy).toBeDefined();
    expect(legacy?.format).toBe("openclaw");
    expect(hasDiagnosticSourceSuffix(result.diagnostics, ".codex-plugin/plugin.json")).toBe(true);
  });

  it("blocks extension entries that escape package directory", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "escape-pack");
    const outside = path.join(stateDir, "outside.js");
    mkdirSafe(globalExt);

    writePluginPackageManifest({
      packageDir: globalExt,
      packageName: "@openclaw/escape-pack",
      extensions: ["../../outside.js"],
    });
    fs.writeFileSync(outside, "export default function () {}", "utf-8");

    const result = await discoverWithStateDir(stateDir, {});

    expect(result.candidates).toHaveLength(0);
    expectEscapesPackageDiagnostic(result.diagnostics);
  });

  it("rejects package extension entries that escape via symlink", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "pack");
    const outsideDir = path.join(stateDir, "outside");
    const linkedDir = path.join(globalExt, "linked");
    mkdirSafe(globalExt);
    mkdirSafe(outsideDir);
    fs.writeFileSync(path.join(outsideDir, "escape.ts"), "export default {}", "utf-8");
    try {
      fs.symlinkSync(outsideDir, linkedDir, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }

    writePluginPackageManifest({
      packageDir: globalExt,
      packageName: "@openclaw/pack",
      extensions: ["./linked/escape.ts"],
    });

    const { candidates, diagnostics } = await discoverWithStateDir(stateDir, {});

    expect(candidates.some((candidate) => candidate.idHint === "pack")).toBe(false);
    expectEscapesPackageDiagnostic(diagnostics);
  });

  it("rejects package extension entries that are hardlinked aliases", async () => {
    if (process.platform === "win32") {
      return;
    }
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "pack");
    const outsideDir = path.join(stateDir, "outside");
    const outsideFile = path.join(outsideDir, "escape.ts");
    const linkedFile = path.join(globalExt, "escape.ts");
    mkdirSafe(globalExt);
    mkdirSafe(outsideDir);
    fs.writeFileSync(outsideFile, "export default {}", "utf-8");
    try {
      fs.linkSync(outsideFile, linkedFile);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }

    writePluginPackageManifest({
      packageDir: globalExt,
      packageName: "@openclaw/pack",
      extensions: ["./escape.ts"],
    });

    const { candidates, diagnostics } = await discoverWithStateDir(stateDir, {});

    expect(candidates.some((candidate) => candidate.idHint === "pack")).toBe(false);
    expectEscapesPackageDiagnostic(diagnostics);
  });

  it("ignores package manifests that are hardlinked aliases", async () => {
    if (process.platform === "win32") {
      return;
    }
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions", "pack");
    const outsideDir = path.join(stateDir, "outside");
    const outsideManifest = path.join(outsideDir, "package.json");
    const linkedManifest = path.join(globalExt, "package.json");
    mkdirSafe(globalExt);
    mkdirSafe(outsideDir);
    fs.writeFileSync(path.join(globalExt, "entry.ts"), "export default {}", "utf-8");
    fs.writeFileSync(
      outsideManifest,
      JSON.stringify({
        name: "@openclaw/pack",
        openclaw: { extensions: ["./entry.ts"] },
      }),
      "utf-8",
    );
    try {
      fs.linkSync(outsideManifest, linkedManifest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EXDEV") {
        return;
      }
      throw err;
    }

    const { candidates } = await discoverWithStateDir(stateDir, {});

    expect(candidates.some((candidate) => candidate.idHint === "pack")).toBe(false);
  });

  it.runIf(process.platform !== "win32")("blocks world-writable plugin paths", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions");
    mkdirSafe(globalExt);
    const pluginPath = path.join(globalExt, "world-open.ts");
    fs.writeFileSync(pluginPath, "export default function () {}", "utf-8");
    fs.chmodSync(pluginPath, 0o777);

    const result = await discoverWithStateDir(stateDir, {});

    expect(result.candidates).toHaveLength(0);
    expect(result.diagnostics.some((diag) => diag.message.includes("world-writable path"))).toBe(
      true,
    );
  });

  it.runIf(process.platform !== "win32")(
    "repairs world-writable bundled plugin dirs before loading them",
    async () => {
      const stateDir = makeTempDir();
      const bundledDir = path.join(stateDir, "bundled");
      const packDir = path.join(bundledDir, "demo-pack");
      mkdirSafe(packDir);
      fs.writeFileSync(path.join(packDir, "index.ts"), "export default function () {}", "utf-8");
      fs.chmodSync(packDir, 0o777);

      const result = discoverOpenClawPlugins({
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: stateDir,
          CLAWDBOT_STATE_DIR: undefined,
          OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
        },
      });

      expect(result.candidates.some((candidate) => candidate.idHint === "demo-pack")).toBe(true);
      expect(
        result.diagnostics.some(
          (diag) => diag.source === packDir && diag.message.includes("world-writable path"),
        ),
      ).toBe(false);
      expect(fs.statSync(packDir).mode & 0o777).toBe(0o755);
    },
  );

  it.runIf(process.platform !== "win32" && typeof process.getuid === "function")(
    "blocks suspicious ownership when uid mismatch is detected",
    async () => {
      const stateDir = makeTempDir();
      const globalExt = path.join(stateDir, "extensions");
      mkdirSafe(globalExt);
      fs.writeFileSync(
        path.join(globalExt, "owner-mismatch.ts"),
        "export default function () {}",
        "utf-8",
      );

      const actualUid = (process as NodeJS.Process & { getuid: () => number }).getuid();
      const result = await discoverWithStateDir(stateDir, { ownershipUid: actualUid + 1 });
      const shouldBlockForMismatch = actualUid !== 0;
      expect(result.candidates).toHaveLength(shouldBlockForMismatch ? 0 : 1);
      expect(result.diagnostics.some((diag) => diag.message.includes("suspicious ownership"))).toBe(
        shouldBlockForMismatch,
      );
    },
  );

  it("reuses discovery results from cache until cleared", async () => {
    const stateDir = makeTempDir();
    const globalExt = path.join(stateDir, "extensions");
    mkdirSafe(globalExt);
    const pluginPath = path.join(globalExt, "cached.ts");
    fs.writeFileSync(pluginPath, "export default function () {}", "utf-8");

    const first = discoverOpenClawPlugins({
      env: {
        ...buildDiscoveryEnv(stateDir),
        OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5000",
      },
    });
    expect(first.candidates.some((candidate) => candidate.idHint === "cached")).toBe(true);

    fs.rmSync(pluginPath, { force: true });

    const second = discoverOpenClawPlugins({
      env: {
        ...buildDiscoveryEnv(stateDir),
        OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5000",
      },
    });
    expect(second.candidates.some((candidate) => candidate.idHint === "cached")).toBe(true);

    clearPluginDiscoveryCache();

    const third = discoverOpenClawPlugins({
      env: {
        ...buildDiscoveryEnv(stateDir),
        OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5000",
      },
    });
    expect(third.candidates.some((candidate) => candidate.idHint === "cached")).toBe(false);
  });

  it("does not reuse discovery results across env root changes", () => {
    const stateDirA = makeTempDir();
    const stateDirB = makeTempDir();
    const globalExtA = path.join(stateDirA, "extensions");
    const globalExtB = path.join(stateDirB, "extensions");
    mkdirSafe(globalExtA);
    mkdirSafe(globalExtB);
    fs.writeFileSync(path.join(globalExtA, "alpha.ts"), "export default function () {}", "utf-8");
    fs.writeFileSync(path.join(globalExtB, "beta.ts"), "export default function () {}", "utf-8");

    const first = discoverOpenClawPlugins({
      env: {
        ...buildDiscoveryEnv(stateDirA),
        OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5000",
      },
    });
    const second = discoverOpenClawPlugins({
      env: {
        ...buildDiscoveryEnv(stateDirB),
        OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5000",
      },
    });

    expect(first.candidates.some((candidate) => candidate.idHint === "alpha")).toBe(true);
    expect(first.candidates.some((candidate) => candidate.idHint === "beta")).toBe(false);
    expect(second.candidates.some((candidate) => candidate.idHint === "alpha")).toBe(false);
    expect(second.candidates.some((candidate) => candidate.idHint === "beta")).toBe(true);
  });

  it("does not reuse extra-path discovery across env home changes", () => {
    const stateDir = makeTempDir();
    const homeA = makeTempDir();
    const homeB = makeTempDir();
    const pluginA = path.join(homeA, "plugins", "demo.ts");
    const pluginB = path.join(homeB, "plugins", "demo.ts");
    mkdirSafe(path.dirname(pluginA));
    mkdirSafe(path.dirname(pluginB));
    fs.writeFileSync(pluginA, "export default {}", "utf-8");
    fs.writeFileSync(pluginB, "export default {}", "utf-8");

    const first = discoverOpenClawPlugins({
      extraPaths: ["~/plugins/demo.ts"],
      env: {
        ...buildDiscoveryEnv(stateDir),
        HOME: homeA,
        OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5000",
      },
    });
    const second = discoverOpenClawPlugins({
      extraPaths: ["~/plugins/demo.ts"],
      env: {
        ...buildDiscoveryEnv(stateDir),
        HOME: homeB,
        OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5000",
      },
    });

    expect(first.candidates.find((candidate) => candidate.idHint === "demo")?.source).toBe(pluginA);
    expect(second.candidates.find((candidate) => candidate.idHint === "demo")?.source).toBe(
      pluginB,
    );
  });

  it("treats configured load-path order as cache-significant", () => {
    const stateDir = makeTempDir();
    const pluginA = path.join(stateDir, "plugins", "alpha.ts");
    const pluginB = path.join(stateDir, "plugins", "beta.ts");
    mkdirSafe(path.dirname(pluginA));
    fs.writeFileSync(pluginA, "export default {}", "utf-8");
    fs.writeFileSync(pluginB, "export default {}", "utf-8");

    const env = {
      ...buildDiscoveryEnv(stateDir),
      OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5000",
    };

    const first = discoverOpenClawPlugins({
      extraPaths: [pluginA, pluginB],
      env,
    });
    const second = discoverOpenClawPlugins({
      extraPaths: [pluginB, pluginA],
      env,
    });

    expect(first.candidates.map((candidate) => candidate.idHint)).toEqual(["alpha", "beta"]);
    expect(second.candidates.map((candidate) => candidate.idHint)).toEqual(["beta", "alpha"]);
  });
});
