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
    OPENCLAW_HOME: undefined,
    OPENCLAW_BUNDLED_PLUGINS_DIR: "/nonexistent/bundled/plugins",
  };
}

function buildCachedDiscoveryEnv(
  stateDir: string,
  overrides: Partial<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
  return {
    ...buildDiscoveryEnv(stateDir),
    OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: "5000",
    ...overrides,
  };
}

async function discoverWithStateDir(
  stateDir: string,
  params: Parameters<typeof discoverOpenClawPlugins>[0],
) {
  return discoverOpenClawPlugins({ ...params, env: buildDiscoveryEnv(stateDir) });
}

function discoverWithCachedEnv(params: Parameters<typeof discoverOpenClawPlugins>[0]) {
  return discoverOpenClawPlugins(params);
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

function writePluginManifest(params: { pluginDir: string; id: string }) {
  fs.writeFileSync(
    path.join(params.pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.id,
      configSchema: { type: "object" },
    }),
    "utf-8",
  );
}

function writePluginEntry(filePath: string) {
  fs.writeFileSync(filePath, "export default function () {}", "utf-8");
}

function writeStandalonePlugin(filePath: string, source = "export default function () {}") {
  mkdirSafe(path.dirname(filePath));
  fs.writeFileSync(filePath, source, "utf-8");
}

function createPackagePlugin(params: {
  packageDir: string;
  packageName: string;
  extensions: string[];
  pluginId?: string;
}) {
  mkdirSafe(params.packageDir);
  writePluginPackageManifest({
    packageDir: params.packageDir,
    packageName: params.packageName,
    extensions: params.extensions,
  });
  if (params.pluginId) {
    writePluginManifest({ pluginDir: params.packageDir, id: params.pluginId });
  }
}

function createPackagePluginWithEntry(params: {
  packageDir: string;
  packageName: string;
  pluginId?: string;
  entryPath?: string;
}) {
  const entryPath = params.entryPath ?? "src/index.ts";
  mkdirSafe(path.dirname(path.join(params.packageDir, entryPath)));
  createPackagePlugin({
    packageDir: params.packageDir,
    packageName: params.packageName,
    extensions: [`./${entryPath}`],
    ...(params.pluginId ? { pluginId: params.pluginId } : {}),
  });
  writePluginEntry(path.join(params.packageDir, entryPath));
}

function createBundleRoot(bundleDir: string, markerPath: string, manifest?: unknown) {
  mkdirSafe(path.dirname(path.join(bundleDir, markerPath)));
  if (manifest) {
    fs.writeFileSync(path.join(bundleDir, markerPath), JSON.stringify(manifest), "utf-8");
    return;
  }
  mkdirSafe(path.join(bundleDir, markerPath));
}

function expectCandidateIds(
  candidates: Array<{ idHint: string }>,
  params: { includes?: readonly string[]; excludes?: readonly string[] },
) {
  const ids = candidates.map((candidate) => candidate.idHint);
  if (params.includes?.length) {
    expect(ids).toEqual(expect.arrayContaining([...params.includes]));
  }
  params.excludes?.forEach((excludedId) => {
    expect(ids).not.toContain(excludedId);
  });
}

function findCandidateById<T extends { idHint?: string }>(candidates: T[], idHint: string) {
  return candidates.find((candidate) => candidate.idHint === idHint);
}

function expectCandidateSource(
  candidates: Array<{ idHint?: string; source?: string }>,
  idHint: string,
  source: string,
) {
  expect(findCandidateById(candidates, idHint)?.source).toBe(source);
}

function expectEscapesPackageDiagnostic(diagnostics: Array<{ message: string }>) {
  expect(diagnostics.some((entry) => entry.message.includes("escapes package directory"))).toBe(
    true,
  );
}

function expectCandidatePresence(
  result: Awaited<ReturnType<typeof discoverOpenClawPlugins>>,
  params: { present?: readonly string[]; absent?: readonly string[] },
) {
  const ids = result.candidates.map((candidate) => candidate.idHint);
  params.present?.forEach((pluginId) => {
    expect(ids).toContain(pluginId);
  });
  params.absent?.forEach((pluginId) => {
    expect(ids).not.toContain(pluginId);
  });
}

async function expectRejectedPackageExtensionEntry(params: {
  stateDir: string;
  setup: (stateDir: string) => boolean | void;
  expectedDiagnostic?: "escapes" | "none";
  expectedId?: string;
}) {
  if (params.setup(params.stateDir) === false) {
    return;
  }
  const result = await discoverWithStateDir(params.stateDir, {});

  if (params.expectedId) {
    expectCandidatePresence(result, { absent: [params.expectedId] });
  } else {
    expect(result.candidates).toHaveLength(0);
  }
  if (params.expectedDiagnostic === "escapes") {
    expectEscapesPackageDiagnostic(result.diagnostics);
    return;
  }
  expect(result.diagnostics).toEqual([]);
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
    writePluginEntry(path.join(globalExt, "src", "one.ts"));
    writePluginEntry(path.join(globalExt, "src", "two.ts"));

    const { candidates } = await discoverWithStateDir(stateDir, {});
    expectCandidateIds(candidates, { includes: ["pack/one", "pack/two"] });
  });

  it("does not discover nested node_modules copies under installed plugins", async () => {
    const stateDir = makeTempDir();
    const pluginDir = path.join(stateDir, "extensions", "opik-openclaw");
    const nestedDiffsDir = path.join(
      pluginDir,
      "node_modules",
      "openclaw",
      "dist",
      "extensions",
      "diffs",
    );
    mkdirSafe(path.join(pluginDir, "src"));
    mkdirSafe(nestedDiffsDir);

    writePluginPackageManifest({
      packageDir: pluginDir,
      packageName: "@opik/opik-openclaw",
      extensions: ["./src/index.ts"],
    });
    writePluginManifest({ pluginDir, id: "opik-openclaw" });
    fs.writeFileSync(
      path.join(pluginDir, "src", "index.ts"),
      "export default function () {}",
      "utf-8",
    );

    writePluginPackageManifest({
      packageDir: path.join(pluginDir, "node_modules", "openclaw"),
      packageName: "openclaw",
      extensions: ["./dist/extensions/diffs/index.js"],
    });
    writePluginManifest({ pluginDir: nestedDiffsDir, id: "diffs" });
    fs.writeFileSync(
      path.join(nestedDiffsDir, "index.js"),
      "module.exports = { id: 'diffs', register() {} };",
      "utf-8",
    );

    const { candidates } = await discoverWithStateDir(stateDir, {});

    expect(candidates.map((candidate) => candidate.idHint)).toEqual(["opik-openclaw"]);
  });

  it.each([
    {
      name: "derives unscoped ids for scoped packages",
      setup: (stateDir: string) => {
        const packageDir = path.join(stateDir, "extensions", "voice-call-pack");
        createPackagePluginWithEntry({
          packageDir,
          packageName: "@openclaw/voice-call",
          entryPath: "src/index.ts",
        });
        return {};
      },
      includes: ["voice-call"],
    },
    {
      name: "strips provider suffixes from package-derived ids",
      setup: (stateDir: string) => {
        const packageDir = path.join(stateDir, "extensions", "ollama-provider-pack");
        createPackagePluginWithEntry({
          packageDir,
          packageName: "@openclaw/ollama-provider",
          pluginId: "ollama",
          entryPath: "src/index.ts",
        });
        return {};
      },
      includes: ["ollama"],
      excludes: ["ollama-provider"],
    },
    {
      name: "normalizes bundled speech package ids to canonical plugin ids",
      setup: (stateDir: string) => {
        for (const [dirName, packageName, pluginId] of [
          ["elevenlabs-speech-pack", "@openclaw/elevenlabs-speech", "elevenlabs"],
          ["microsoft-speech-pack", "@openclaw/microsoft-speech", "microsoft"],
        ] as const) {
          const packageDir = path.join(stateDir, "extensions", dirName);
          createPackagePluginWithEntry({
            packageDir,
            packageName,
            pluginId,
            entryPath: "src/index.ts",
          });
        }
        return {};
      },
      includes: ["elevenlabs", "microsoft"],
      excludes: ["elevenlabs-speech", "microsoft-speech"],
    },
    {
      name: "treats configured directory paths as plugin packages",
      setup: (stateDir: string) => {
        const packageDir = path.join(stateDir, "packs", "demo-plugin-dir");
        createPackagePluginWithEntry({
          packageDir,
          packageName: "@openclaw/demo-plugin-dir",
          entryPath: "index.js",
        });
        return { extraPaths: [packageDir] };
      },
      includes: ["demo-plugin-dir"],
    },
  ] as const)("$name", async ({ setup, includes, excludes }) => {
    const stateDir = makeTempDir();
    const discoverParams = setup(stateDir);
    const { candidates } = await discoverWithStateDir(stateDir, discoverParams);
    expectCandidateIds(candidates, { includes, excludes });
  });

  it.each([
    {
      name: "auto-detects Codex bundles as bundle candidates",
      idHint: "sample-bundle",
      bundleFormat: "codex",
      setup: (stateDir: string) => {
        const bundleDir = path.join(stateDir, "extensions", "sample-bundle");
        createBundleRoot(bundleDir, ".codex-plugin/plugin.json", {
          name: "Sample Bundle",
          skills: "skills",
        });
        mkdirSafe(path.join(bundleDir, "skills"));
        return bundleDir;
      },
      expectRootDir: true,
    },
    {
      name: "auto-detects manifestless Claude bundles from the default layout",
      idHint: "claude-bundle",
      bundleFormat: "claude",
      setup: (stateDir: string) => {
        const bundleDir = path.join(stateDir, "extensions", "claude-bundle");
        mkdirSafe(path.join(bundleDir, "commands"));
        fs.writeFileSync(
          path.join(bundleDir, "settings.json"),
          '{"hideThinkingBlock":true}',
          "utf-8",
        );
        return bundleDir;
      },
    },
    {
      name: "auto-detects Cursor bundles as bundle candidates",
      idHint: "cursor-bundle",
      bundleFormat: "cursor",
      setup: (stateDir: string) => {
        const bundleDir = path.join(stateDir, "extensions", "cursor-bundle");
        createBundleRoot(bundleDir, ".cursor-plugin/plugin.json", {
          name: "Cursor Bundle",
        });
        mkdirSafe(path.join(bundleDir, ".cursor", "commands"));
        return bundleDir;
      },
    },
  ] as const)("$name", async ({ idHint, bundleFormat, setup, expectRootDir }) => {
    const stateDir = makeTempDir();
    const bundleDir = setup(stateDir);
    const { candidates } = await discoverWithStateDir(stateDir, {});
    const bundle = findCandidateById(candidates, idHint);

    expect(bundle).toBeDefined();
    expect(bundle).toEqual(
      expect.objectContaining({
        idHint,
        format: "bundle",
        bundleFormat,
        source: bundleDir,
      }),
    );
    if (expectRootDir) {
      expect(normalizePathForAssertion(bundle?.rootDir)).toBe(
        normalizePathForAssertion(fs.realpathSync(bundleDir)),
      );
    }
  });

  it.each([
    {
      name: "falls back to legacy index discovery when a scanned bundle sidecar is malformed",
      bundleMarker: ".claude-plugin/plugin.json",
      setup: (stateDir: string) => {
        const pluginDir = path.join(stateDir, "extensions", "legacy-with-bad-bundle");
        mkdirSafe(path.dirname(path.join(pluginDir, ".claude-plugin", "plugin.json")));
        fs.writeFileSync(path.join(pluginDir, "index.ts"), "export default {}", "utf-8");
        fs.writeFileSync(path.join(pluginDir, ".claude-plugin", "plugin.json"), "{", "utf-8");
        return {};
      },
    },
    {
      name: "falls back to legacy index discovery for configured paths with malformed bundle sidecars",
      bundleMarker: ".codex-plugin/plugin.json",
      setup: (stateDir: string) => {
        const pluginDir = path.join(stateDir, "plugins", "legacy-with-bad-bundle");
        mkdirSafe(path.dirname(path.join(pluginDir, ".codex-plugin", "plugin.json")));
        fs.writeFileSync(path.join(pluginDir, "index.ts"), "export default {}", "utf-8");
        fs.writeFileSync(path.join(pluginDir, ".codex-plugin", "plugin.json"), "{", "utf-8");
        return { extraPaths: [pluginDir] };
      },
    },
  ] as const)("$name", async ({ setup, bundleMarker }) => {
    const stateDir = makeTempDir();
    const result = await discoverWithStateDir(stateDir, setup(stateDir));
    const legacy = findCandidateById(result.candidates, "legacy-with-bad-bundle");

    expect(legacy?.format).toBe("openclaw");
    expect(hasDiagnosticSourceSuffix(result.diagnostics, bundleMarker)).toBe(true);
  });

  it.each([
    {
      name: "blocks extension entries that escape package directory",
      expectedDiagnostic: "escapes" as const,
      setup: (stateDir: string) => {
        const globalExt = path.join(stateDir, "extensions", "escape-pack");
        const outside = path.join(stateDir, "outside.js");
        mkdirSafe(globalExt);
        writePluginPackageManifest({
          packageDir: globalExt,
          packageName: "@openclaw/escape-pack",
          extensions: ["../../outside.js"],
        });
        fs.writeFileSync(outside, "export default function () {}", "utf-8");
      },
    },
    {
      name: "skips missing package extension entries without escape diagnostics",
      expectedDiagnostic: "none" as const,
      setup: (stateDir: string) => {
        const globalExt = path.join(stateDir, "extensions", "missing-entry-pack");
        mkdirSafe(globalExt);
        writePluginPackageManifest({
          packageDir: globalExt,
          packageName: "@openclaw/missing-entry-pack",
          extensions: ["./missing.ts"],
        });
      },
    },
    {
      name: "rejects package extension entries that escape via symlink",
      expectedDiagnostic: "escapes" as const,
      expectedId: "pack",
      setup: (stateDir: string) => {
        const globalExt = path.join(stateDir, "extensions", "pack");
        const outsideDir = path.join(stateDir, "outside");
        const linkedDir = path.join(globalExt, "linked");
        mkdirSafe(globalExt);
        mkdirSafe(outsideDir);
        fs.writeFileSync(path.join(outsideDir, "escape.ts"), "export default {}", "utf-8");
        try {
          fs.symlinkSync(outsideDir, linkedDir, process.platform === "win32" ? "junction" : "dir");
        } catch {
          return false;
        }
        writePluginPackageManifest({
          packageDir: globalExt,
          packageName: "@openclaw/pack",
          extensions: ["./linked/escape.ts"],
        });
      },
    },
    {
      name: "rejects package extension entries that are hardlinked aliases",
      expectedDiagnostic: "escapes" as const,
      expectedId: "pack",
      setup: (stateDir: string) => {
        if (process.platform === "win32") {
          return false;
        }
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
            return false;
          }
          throw err;
        }
        writePluginPackageManifest({
          packageDir: globalExt,
          packageName: "@openclaw/pack",
          extensions: ["./escape.ts"],
        });
      },
    },
  ] as const)("$name", async ({ setup, expectedDiagnostic, expectedId }) => {
    const stateDir = makeTempDir();
    await expectRejectedPackageExtensionEntry({
      stateDir,
      setup,
      expectedDiagnostic,
      ...(expectedId ? { expectedId } : {}),
    });
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

    const cachedEnv = buildCachedDiscoveryEnv(stateDir);
    const first = discoverWithCachedEnv({ env: cachedEnv });
    expect(first.candidates.some((candidate) => candidate.idHint === "cached")).toBe(true);

    fs.rmSync(pluginPath, { force: true });

    const second = discoverWithCachedEnv({ env: cachedEnv });
    expect(second.candidates.some((candidate) => candidate.idHint === "cached")).toBe(true);

    clearPluginDiscoveryCache();

    const third = discoverWithCachedEnv({ env: cachedEnv });
    expect(third.candidates.some((candidate) => candidate.idHint === "cached")).toBe(false);
  });

  it.each([
    {
      name: "does not reuse discovery results across env root changes",
      setup: () => {
        const stateDirA = makeTempDir();
        const stateDirB = makeTempDir();
        writeStandalonePlugin(path.join(stateDirA, "extensions", "alpha.ts"));
        writeStandalonePlugin(path.join(stateDirB, "extensions", "beta.ts"));
        return {
          first: discoverWithCachedEnv({ env: buildCachedDiscoveryEnv(stateDirA) }),
          second: discoverWithCachedEnv({ env: buildCachedDiscoveryEnv(stateDirB) }),
          assert: (
            first: ReturnType<typeof discoverWithCachedEnv>,
            second: ReturnType<typeof discoverWithCachedEnv>,
          ) => {
            expectCandidatePresence(first, { present: ["alpha"], absent: ["beta"] });
            expectCandidatePresence(second, { present: ["beta"], absent: ["alpha"] });
          },
        };
      },
    },
    {
      name: "does not reuse extra-path discovery across env home changes",
      setup: () => {
        const stateDir = makeTempDir();
        const homeA = makeTempDir();
        const homeB = makeTempDir();
        const pluginA = path.join(homeA, "plugins", "demo.ts");
        const pluginB = path.join(homeB, "plugins", "demo.ts");
        writeStandalonePlugin(pluginA, "export default {}");
        writeStandalonePlugin(pluginB, "export default {}");
        return {
          first: discoverWithCachedEnv({
            extraPaths: ["~/plugins/demo.ts"],
            env: buildCachedDiscoveryEnv(stateDir, { HOME: homeA }),
          }),
          second: discoverWithCachedEnv({
            extraPaths: ["~/plugins/demo.ts"],
            env: buildCachedDiscoveryEnv(stateDir, { HOME: homeB }),
          }),
          assert: (
            first: ReturnType<typeof discoverWithCachedEnv>,
            second: ReturnType<typeof discoverWithCachedEnv>,
          ) => {
            expectCandidateSource(first.candidates, "demo", pluginA);
            expectCandidateSource(second.candidates, "demo", pluginB);
          },
        };
      },
    },
  ] as const)("$name", ({ setup }) => {
    const { first, second, assert } = setup();
    assert(first, second);
  });

  it("treats configured load-path order as cache-significant", () => {
    const stateDir = makeTempDir();
    const pluginA = path.join(stateDir, "plugins", "alpha.ts");
    const pluginB = path.join(stateDir, "plugins", "beta.ts");
    writeStandalonePlugin(pluginA, "export default {}");
    writeStandalonePlugin(pluginB, "export default {}");

    const env = buildCachedDiscoveryEnv(stateDir);

    const first = discoverWithCachedEnv({
      extraPaths: [pluginA, pluginB],
      env,
    });
    const second = discoverWithCachedEnv({
      extraPaths: [pluginB, pluginA],
      env,
    });

    expect(first.candidates.map((candidate) => candidate.idHint)).toEqual(["alpha", "beta"]);
    expect(second.candidates.map((candidate) => candidate.idHint)).toEqual(["beta", "alpha"]);
  });
});
