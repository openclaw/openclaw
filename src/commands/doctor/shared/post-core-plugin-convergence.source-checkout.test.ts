import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { runPluginUpdateCommand } from "../../../cli/plugins-update-command.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import { filterRecordsToActive } from "../../../plugins/active-payload-verification.js";
import { resolvePluginNpmGenerationProjectDir } from "../../../plugins/install-paths.js";
import { readPersistedInstalledPluginIndexInstallRecordsAsync as readRecords } from "../../../plugins/installed-plugin-index-records.js";
import { loadPluginManifestRegistryCore } from "../../../plugins/manifest-registry.js";
import { createPluginCache, withPluginCache } from "../../../plugins/plugin-cache.js";
import { writeArtifact as writeText } from "../../../plugins/public-surface.test-support.js";
import { seedInstalledPluginIndex } from "../../../plugins/test-helpers/installed-plugin-index.js";
import { convergePluginReleaseCohort } from "../../../plugins/update-cohort.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { runPostCorePluginConvergence } from "./post-core-plugin-convergence.js";

const mocks = vi.hoisted(() => ({
  hostRoot: "",
  getRuntimeConfig: vi.fn<() => OpenClawConfig>(),
  log: vi.fn(),
  error: vi.fn(),
  resolveNpmSpecMetadata:
    vi.fn<typeof import("../../../infra/install-source-utils.js").resolveNpmSpecMetadata>(),
  installPluginFromNpmSpec:
    vi.fn<typeof import("../../../plugins/install.js").installPluginFromNpmSpec>(),
}));

vi.mock("../../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config/config.js")>()),
  getRuntimeConfig: mocks.getRuntimeConfig,
}));

vi.mock("../../../runtime.js", () => ({
  defaultRuntime: {
    log: mocks.log,
    error: mocks.error,
    exit: (code: number) => {
      throw new Error(`CLI exited with ${code}: ${mocks.error.mock.lastCall?.join(" ")}`);
    },
  },
}));

vi.mock("../../../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRootSync: () => mocks.hostRoot,
  resolveOpenClawPackageRoot: async () => mocks.hostRoot,
}));

vi.mock("../../../infra/install-source-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../infra/install-source-utils.js")>()),
  resolveNpmSpecMetadata: mocks.resolveNpmSpecMetadata,
}));

vi.mock("../../../plugins/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/install.js")>()),
  installPluginFromNpmSpec: mocks.installPluginFromNpmSpec,
}));

const HOST_VERSION = "2026.9.4";
const NEW_EXPORT = "registerNativeHookRelayForBundledRuntime";
const OLD_EXPORT = "registerRetainedNativeHookRelayForBundledRuntime";
const LINK_TYPE = process.platform === "win32" ? "junction" : "dir";
const SDK = "plugin-sdk/native-hook-relay-runtime";
const writeJson = (filePath: string, value: unknown) => writeText(filePath, JSON.stringify(value));

function writeCodexPackage(root: string, sdkExport: string, version = HOST_VERSION): string {
  writeJson(path.join(root, "package.json"), {
    name: "@openclaw/codex",
    version,
    type: "module",
    peerDependencies: { openclaw: ">=2026.9.4" },
    openclaw: {
      extensions: ["./dist/index.js"],
      install: { npmSpec: "@openclaw/codex", defaultChoice: "npm" },
      compat: { pluginApi: ">=2026.9.4" },
      build: { openclawVersion: HOST_VERSION },
    },
  });
  writeJson(path.join(root, "openclaw.plugin.json"), {
    id: "codex",
    version,
    configSchema: { type: "object" },
  });
  const entry = writeText(
    path.join(root, "dist", "index.js"),
    `import { ${sdkExport} } from "openclaw/${SDK}";
export function runTurn() { return ${sdkExport}(); }
export default { id: "codex", register() {} };
`,
  );
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  fs.symlinkSync(mocks.hostRoot, path.join(root, "node_modules", "openclaw"), LINK_TYPE);
  return entry;
}

function importAndRun(entry: string, env: NodeJS.ProcessEnv) {
  const script =
    "const plugin = await import(process.argv[1]); process.stdout.write(plugin.runTurn());";
  return spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script, pathToFileURL(entry).href],
    { encoding: "utf8", env: { ...env, PATH: process.env.PATH } },
  );
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

it.each([
  ["doctor", "2026.9.3", true, false, false],
  ["doctor", "2026.9.3", false, false, true],
  ["doctor", HOST_VERSION, false, true, false],
  ["cli named", HOST_VERSION, false, false, false],
  ["cli all", HOST_VERSION, false, false, false],
  ["stable", HOST_VERSION, false, false, false],
] as const)(
  "keeps the rebuilt plugin for %s (npm=%s, selector=%s, corrupt=%s, packaged=%s)",
  async (flow, version, selector, corrupt, packaged) => {
    const root = tempDirs.make("openclaw-source-convergence-");
    const hostRoot = path.join(root, "host");
    const stateDir = path.join(root, "state");
    const bundledDir = path.join(hostRoot, "dist", "extensions", "codex");
    mocks.hostRoot = hostRoot;
    writeJson(path.join(hostRoot, "package.json"), {
      name: "openclaw",
      version: HOST_VERSION,
      type: "module",
      exports: { [`./${SDK}`]: `./dist/${SDK}.js` },
    });
    if (packaged) {
      writeJson(path.join(hostRoot, "dist", "build-info.json"), {
        commit: "a".repeat(40),
        stagedOfficialPlugins: { commit: "a".repeat(40), pluginIds: ["codex"] },
      });
    } else {
      fs.mkdirSync(path.join(hostRoot, "src"), { recursive: true });
      fs.mkdirSync(path.join(hostRoot, "extensions"), { recursive: true });
      fs.writeFileSync(path.join(hostRoot, "pnpm-workspace.yaml"), "packages: []\n");
    }
    writeText(
      path.join(hostRoot, "dist", `${SDK}.js`),
      `export function ${NEW_EXPORT}() { return "synthetic turn completed"; }\n`,
    );
    writeCodexPackage(bundledDir, NEW_EXPORT);
    const npmRoot = resolvePluginNpmGenerationProjectDir({
      npmDir: path.join(stateDir, "npm"),
      packageName: "@openclaw/codex",
      generationKey: `@openclaw/codex@${version}`,
    });
    writeJson(path.join(npmRoot, "package.json"), {
      dependencies: { "@openclaw/codex": version },
    });
    const npmDir = path.join(npmRoot, "node_modules", "@openclaw", "codex");
    const npmPackage = path.join(npmDir, "package.json");
    const npmEntry = writeCodexPackage(npmDir, OLD_EXPORT, version);
    const env: NodeJS.ProcessEnv = {
      HOME: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: HOST_VERSION,
      OPENCLAW_COMPATIBILITY_HOST_VERSION: HOST_VERSION,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.dirname(bundledDir),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      OPENCLAW_DEV_SOURCE_ROOT: selector ? hostRoot : undefined,
    };
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }
    const cfg: OpenClawConfig = {
      update: { channel: "dev" },
      plugins: { allow: ["codex"], entries: { codex: { enabled: true } } },
    };
    mocks.getRuntimeConfig.mockReturnValue(cfg);
    const records: Record<string, PluginInstallRecord> = {
      codex: {
        source: "npm",
        spec: "@openclaw/codex",
        installPath: npmDir,
        version,
        resolvedName: "@openclaw/codex",
        resolvedVersion: version,
        resolvedSpec: `@openclaw/codex@${version}`,
      },
    };
    try {
      await withPluginCache(createPluginCache(), async () => {
        const published = importAndRun(npmEntry, env);
        expect(published.status).not.toBe(0);
        expect(published.stderr).toMatch(
          new RegExp(
            `(?:does not provide an export named '${OLD_EXPORT}'|Export named '${OLD_EXPORT}' not found in module)`,
          ),
        );
        await seedInstalledPluginIndex(records, { config: cfg, env });
      });
      if (corrupt) {
        fs.writeFileSync(npmPackage, "{invalid package json");
      }
      const npmPackageBefore = fs.readFileSync(npmPackage, "utf8");

      await withPluginCache(createPluginCache(), async () => {
        const result = await runPostCorePluginConvergence({
          cfg,
          env,
          compatibilityHostVersion: HOST_VERSION,
        });
        expect.soft(result).toMatchObject({
          installRecords: records,
          errored: false,
          smokeFailures: [],
          warnings: [],
        });
        expect.soft(fs.readFileSync(npmPackage, "utf8")).toBe(npmPackageBefore);
        expect.soft(await readRecords({ env })).toEqual(records);
        const registry = loadPluginManifestRegistryCore({ config: cfg, env });
        const selected = registry.plugins.find((plugin) => plugin.id === "codex");
        const loaded = importAndRun(expectDefined(selected, "selected bundled Codex").source, env);
        expect
          .soft(loaded, loaded.stderr)
          .toMatchObject({ status: 0, stdout: "synthetic turn completed" });
        if (flow === "cli named" || flow === "cli all") {
          await runPluginUpdateCommand({
            ids: flow === "cli named" ? ["codex"] : [],
            opts: { all: flow === "cli all", dryRun: true },
          });
          expect(mocks.error).not.toHaveBeenCalled();
          expect(mocks.log.mock.calls.flat().join("\n")).toContain('Kept bundled plugin "codex"');
        } else if (flow === "stable") {
          const cohort = await convergePluginReleaseCohort({
            config: { ...cfg, plugins: { ...cfg.plugins, installs: records } },
            channel: flow,
            coreVersion: HOST_VERSION,
            timeoutMs: 60_000,
            env,
          });
          expect(cohort.config.plugins?.installs).toEqual(records);
          expect(cohort.updateOutcomes).toContainEqual(
            expect.objectContaining({ pluginId: "codex", code: "source-bundled-plugin" }),
          );
        }
        expect(mocks.resolveNpmSpecMetadata).not.toHaveBeenCalled();
        expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
        if (version === HOST_VERSION && !selector && !corrupt) {
          const override = path.join(root, "selected-plugin");
          fs.symlinkSync(npmDir, override, LINK_TYPE);
          const selectedConfig: OpenClawConfig = {
            ...cfg,
            plugins: { ...cfg.plugins, load: { paths: [override] } },
          };
          expect(filterRecordsToActive({ cfg: selectedConfig, records, env })).toEqual(records);
        }
      });
    } finally {
      await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
    }
  },
);
