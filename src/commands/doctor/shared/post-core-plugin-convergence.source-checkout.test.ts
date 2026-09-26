import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { runPluginUpdateCommand } from "../../../cli/plugins-update-command.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import {
  filterRecordsToActive,
  runActivePluginPayloadSmokeCheck,
} from "../../../plugins/active-payload-verification.js";
import { resolvePluginNpmGenerationProjectDir } from "../../../plugins/install-paths.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "../../../plugins/installed-plugin-index-records.js";
import { loadPluginManifestRegistryCore } from "../../../plugins/manifest-registry.js";
import { createPluginCache, withPluginCache } from "../../../plugins/plugin-cache.js";
import { seedInstalledPluginIndex } from "../../../plugins/test-helpers/installed-plugin-index.js";
import { convergePluginReleaseCohort } from "../../../plugins/update-cohort.js";
import { closeOpenClawStateDatabaseByPath } from "../../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { repairMissingConfiguredPluginInstalls } from "./missing-configured-plugin-install.js";
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

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function writeCodexPackage(params: {
  root: string;
  hostRoot: string;
  version: string;
  sdkExport: string;
}): string {
  writeJson(path.join(params.root, "package.json"), {
    name: "@openclaw/codex",
    version: params.version,
    type: "module",
    peerDependencies: { openclaw: ">=2026.9.4" },
    openclaw: {
      extensions: ["./dist/index.js"],
      install: { npmSpec: "@openclaw/codex", defaultChoice: "npm" },
      compat: { pluginApi: ">=2026.9.4" },
      build: { openclawVersion: HOST_VERSION },
    },
  });
  writeJson(path.join(params.root, "openclaw.plugin.json"), {
    id: "codex",
    version: params.version,
    configSchema: { type: "object" },
  });
  const entry = path.join(params.root, "dist", "index.js");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(
    entry,
    `import { ${params.sdkExport} } from "openclaw/plugin-sdk/native-hook-relay-runtime";
export function runTurn() { return ${params.sdkExport}(); }
export default { id: "codex", register() {} };
`,
  );
  fs.mkdirSync(path.join(params.root, "node_modules"), { recursive: true });
  fs.symlinkSync(
    params.hostRoot,
    path.join(params.root, "node_modules", "openclaw"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return entry;
}

function importAndRun(entry: string, env: NodeJS.ProcessEnv) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "const plugin = await import(process.argv[1]); process.stdout.write(plugin.runTurn());",
      pathToFileURL(entry).href,
    ],
    { encoding: "utf8", env: { ...env, PATH: process.env.PATH } },
  );
}

describe("post-core convergence on source checkouts", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    { version: "2026.9.3", selector: false, corrupt: false, flow: "doctor" },
    { version: HOST_VERSION, selector: false, corrupt: false, flow: "doctor" },
    { version: "2026.9.3", selector: true, corrupt: false, flow: "doctor" },
    { version: HOST_VERSION, selector: true, corrupt: false, flow: "doctor" },
    { version: HOST_VERSION, selector: false, corrupt: true, flow: "doctor" },
    ...["cli named", "cli all", "stable", "beta"].map((flow) => ({
      version: HOST_VERSION,
      selector: false,
      corrupt: false,
      flow,
    })),
  ])(
    "keeps the rebuilt plugin with npm $version (selector=$selector, corrupt=$corrupt, flow=$flow)",
    async ({ version, selector, corrupt, flow }) => {
      const root = tempDirs.make("openclaw-source-convergence-");
      const hostRoot = path.join(root, "host");
      const stateDir = path.join(root, "state");
      const bundledDir = path.join(hostRoot, "dist", "extensions", "codex");
      mocks.hostRoot = hostRoot;
      writeJson(path.join(hostRoot, "package.json"), {
        name: "openclaw",
        version: HOST_VERSION,
        type: "module",
        exports: {
          "./plugin-sdk/native-hook-relay-runtime":
            "./dist/plugin-sdk/native-hook-relay-runtime.js",
        },
      });
      fs.mkdirSync(path.join(hostRoot, "src"), { recursive: true });
      fs.mkdirSync(path.join(hostRoot, "extensions"), { recursive: true });
      fs.writeFileSync(path.join(hostRoot, "pnpm-workspace.yaml"), "packages: []\n");
      const sdkDir = path.join(hostRoot, "dist", "plugin-sdk");
      fs.mkdirSync(sdkDir, { recursive: true });
      fs.writeFileSync(
        path.join(sdkDir, "native-hook-relay-runtime.js"),
        `export function ${NEW_EXPORT}() { return "synthetic turn completed"; }\n`,
      );
      writeCodexPackage({
        root: bundledDir,
        hostRoot,
        version: HOST_VERSION,
        sdkExport: NEW_EXPORT,
      });
      const npmRoot = resolvePluginNpmGenerationProjectDir({
        npmDir: path.join(stateDir, "npm"),
        packageName: "@openclaw/codex",
        generationKey: `@openclaw/codex@${version}`,
      });
      writeJson(path.join(npmRoot, "package.json"), {
        dependencies: { "@openclaw/codex": version },
      });
      const npmDir = path.join(npmRoot, "node_modules", "@openclaw", "codex");
      const npmEntry = writeCodexPackage({
        root: npmDir,
        hostRoot,
        version,
        sdkExport: OLD_EXPORT,
      });
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
      const metadata = {
        name: "@openclaw/codex",
        version: HOST_VERSION,
        resolvedSpec: `@openclaw/codex@${HOST_VERSION}`,
      };
      mocks.resolveNpmSpecMetadata.mockResolvedValue({ ok: true, metadata });
      mocks.installPluginFromNpmSpec.mockResolvedValue({
        ok: true,
        pluginId: "codex",
        targetDir: npmDir,
        version: HOST_VERSION,
        extensions: ["./dist/index.js"],
        npmResolution: metadata,
      });

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
          fs.writeFileSync(path.join(npmDir, "package.json"), "{invalid package json");
        }
        const npmPackageBefore = fs.readFileSync(path.join(npmDir, "package.json"), "utf8");

        await withPluginCache(createPluginCache(), async () => {
          const result = await runPostCorePluginConvergence({
            cfg,
            env,
            compatibilityHostVersion: HOST_VERSION,
          });
          expect.soft(mocks.resolveNpmSpecMetadata).not.toHaveBeenCalled();
          expect.soft(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
          expect.soft(result.installRecords).toEqual(records);
          expect.soft(result.errored).toBe(false);
          expect.soft(result.smokeFailures).toEqual([]);
          expect.soft(result.warnings).toEqual([]);
          expect.soft(result.outcomes).toContainEqual(
            expect.objectContaining({
              pluginId: "codex",
              status: "unchanged",
              code: "source-bundled-plugin",
            }),
          );
          expect.soft(result.changes.join("\n")).not.toContain("Refreshed stale configured plugin");
          expect
            .soft(fs.readFileSync(path.join(npmDir, "package.json"), "utf8"))
            .toBe(npmPackageBefore);
          expect.soft(readPersistedInstalledPluginIndexInstallRecords({ env })).toEqual(records);
          const registry = loadPluginManifestRegistryCore({ config: cfg, env });
          const selected = registry.plugins.find((plugin) => plugin.id === "codex");
          expect.soft(selected).toMatchObject({ origin: "bundled", rootDir: bundledDir });
          if (!selected) {
            throw new Error("Codex disappeared during source checkout convergence");
          }
          const loaded = importAndRun(selected.source, env);
          expect.soft(loaded.status, loaded.stderr).toBe(0);
          expect.soft(loaded.stdout).toBe("synthetic turn completed");
          const startup = await runActivePluginPayloadSmokeCheck({ cfg, records, env });
          expect(startup.failures).toEqual([]);
          if (flow === "cli named" || flow === "cli all") {
            await runPluginUpdateCommand({
              ids: flow === "cli named" ? ["codex"] : [],
              opts: { all: flow === "cli all", dryRun: true },
            });
            expect(mocks.error).not.toHaveBeenCalled();
            expect(mocks.log.mock.calls.flat().join("\n")).toContain('Kept bundled plugin "codex"');
          } else if (flow === "stable" || flow === "beta") {
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
            fs.symlinkSync(npmDir, override, process.platform === "win32" ? "junction" : "dir");
            const selectedConfig: OpenClawConfig = {
              ...cfg,
              plugins: { ...cfg.plugins, load: { paths: [override] } },
            };
            expect(filterRecordsToActive({ cfg: selectedConfig, records, env })).toEqual(records);
            const sourceOnlyDir = path.join(hostRoot, "extensions", "codex");
            writeCodexPackage({
              root: sourceOnlyDir,
              hostRoot,
              version: HOST_VERSION,
              sdkExport: NEW_EXPORT,
            });
            withPluginCache(createPluginCache(), () => {
              const sourceOnlyRegistry = loadPluginManifestRegistryCore({
                config: cfg,
                env: { ...env, OPENCLAW_BUNDLED_PLUGINS_DIR: path.dirname(sourceOnlyDir) },
                installRecords: records,
              });
              expect(
                sourceOnlyRegistry.plugins.find((plugin) => plugin.id === "codex"),
              ).toMatchObject({
                origin: "global",
                rootDir: npmDir,
              });
            });
          }
        });
      } finally {
        closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(env));
      }
    },
  );
});

const DISCORD_CORE_VERSION = "2026.9.6";
const DISCORD_CHANNEL_CONFIG: OpenClawConfig = {
  channels: { discord: { enabled: true, token: "x" } },
};

function writeDiscordPackage(root: string, version: string, layout: "source" | "published"): void {
  writeJson(path.join(root, "package.json"), {
    name: "@openclaw/discord",
    version,
    type: "module",
    openclaw: { extensions: ["./index.js"] },
  });
  writeJson(path.join(root, "openclaw.plugin.json"), {
    id: "discord",
    version,
    channels: ["discord"],
    configSchema: { type: "object" },
    ...(layout === "published"
      ? { channelConfigs: { discord: { schema: { type: "object" } } } }
      : {}),
  });
  fs.writeFileSync(
    path.join(root, "index.js"),
    'export default { id: "discord", register() {} };\n',
  );
}

describe("post-core convergence of abandoned source-checkout path records", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function seedAbandonedCheckout(
    options: { hardlinkedManifest?: boolean; checkoutLayout?: "source" | "published" } = {},
  ) {
    const root = tempDirs.make("openclaw-abandoned-checkout-");
    const hostRoot = path.join(root, "host");
    const checkout = path.join(root, "checkout");
    const stateDir = path.join(root, "state");
    const checkoutPluginDir = path.join(checkout, "extensions", "discord");
    const npmDir = path.join(stateDir, "npm", "node_modules", "@openclaw", "discord");
    mocks.hostRoot = hostRoot;
    writeJson(path.join(hostRoot, "package.json"), {
      name: "openclaw",
      version: DISCORD_CORE_VERSION,
    });
    fs.mkdirSync(path.join(hostRoot, "dist", "extensions"), { recursive: true });
    writeJson(path.join(checkout, "package.json"), { name: "openclaw" });
    fs.mkdirSync(path.join(checkout, ".git"), { recursive: true });
    fs.mkdirSync(path.join(checkout, "src"), { recursive: true });
    fs.writeFileSync(path.join(checkout, "pnpm-workspace.yaml"), "packages: []\n");
    writeDiscordPackage(checkoutPluginDir, "2026.9.2", options.checkoutLayout ?? "source");
    if (options.hardlinkedManifest) {
      fs.linkSync(
        path.join(checkoutPluginDir, "openclaw.plugin.json"),
        path.join(root, "manifest-link.json"),
      );
    }
    const env: NodeJS.ProcessEnv = {
      HOME: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_VERSION: DISCORD_CORE_VERSION,
      OPENCLAW_COMPATIBILITY_HOST_VERSION: DISCORD_CORE_VERSION,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(hostRoot, "dist", "extensions"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      OPENCLAW_DEV_SOURCE_ROOT: undefined,
    };
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }
    mocks.getRuntimeConfig.mockReturnValue(DISCORD_CHANNEL_CONFIG);
    const records: Record<string, PluginInstallRecord> = {
      discord: {
        source: "path",
        sourcePath: checkoutPluginDir,
        installPath: checkoutPluginDir,
        spec: "@openclaw/discord@2026.9.2",
        version: "2026.9.2",
      },
    };
    const metadata = {
      name: "@openclaw/discord",
      version: DISCORD_CORE_VERSION,
      resolvedSpec: `@openclaw/discord@${DISCORD_CORE_VERSION}`,
    };
    mocks.resolveNpmSpecMetadata.mockResolvedValue({ ok: true, metadata });
    mocks.installPluginFromNpmSpec.mockImplementation(async (installOptions) => {
      writeDiscordPackage(npmDir, DISCORD_CORE_VERSION, "published");
      await installOptions.onBeforePluginArtifactCommit?.({
        pluginId: "discord",
        stagedArtifactDir: npmDir,
        mode: "install",
        sourceRecord: { source: "npm", spec: installOptions.spec, ...metadata },
      });
      return {
        ok: true,
        pluginId: "discord",
        targetDir: npmDir,
        version: DISCORD_CORE_VERSION,
        extensions: ["./index.js"],
        npmResolution: metadata,
      };
    });
    await withPluginCache(createPluginCache(), async () => {
      await seedInstalledPluginIndex(records, { config: DISCORD_CHANNEL_CONFIG, env });
    });
    return { env, records, checkout, checkoutPluginDir, npmDir };
  }

  async function runUpdateFlow(params: {
    flow: string;
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    records: Record<string, PluginInstallRecord>;
  }) {
    return await withPluginCache(createPluginCache(), async () => {
      if (params.flow === "doctor") {
        return {
          convergence: await runPostCorePluginConvergence({
            cfg: params.cfg,
            env: params.env,
            compatibilityHostVersion: DISCORD_CORE_VERSION,
          }),
        };
      }
      const cohort = await convergePluginReleaseCohort({
        config: { ...params.cfg, plugins: { ...params.cfg.plugins, installs: params.records } },
        channel: "stable",
        coreVersion: DISCORD_CORE_VERSION,
        timeoutMs: 60_000,
        env: params.env,
      });
      const convergence = await runPostCorePluginConvergence({
        cfg: cohort.config,
        env: params.env,
        compatibilityHostVersion: DISCORD_CORE_VERSION,
        baselineInstallRecords: cohort.config.plugins?.installs ?? {},
      });
      return { cohort, convergence };
    });
  }

  it.each(["update repair", "doctor"])(
    "replaces a source-checkout Discord path record with the official package after its load path is removed (%s)",
    async (flow) => {
      const { env, records, checkoutPluginDir, npmDir } = await seedAbandonedCheckout();
      try {
        const { convergence } = await runUpdateFlow({
          flow,
          cfg: DISCORD_CHANNEL_CONFIG,
          env,
          records,
        });

        expect(mocks.installPluginFromNpmSpec).toHaveBeenCalledTimes(1);
        expect(mocks.installPluginFromNpmSpec.mock.calls[0]?.[0]).toMatchObject({
          spec: `@openclaw/discord@${DISCORD_CORE_VERSION}`,
          expectedPluginId: "discord",
          trustedSourceLinkedOfficialInstall: true,
        });
        expect(convergence.installRecords.discord).toMatchObject({
          source: "npm",
          spec: "@openclaw/discord",
          installPath: npmDir,
          version: DISCORD_CORE_VERSION,
        });
        expect(convergence.repairedPluginIds).toEqual(["discord"]);
        expect(convergence.changes).toContain(
          `Replaced source-checkout copy of plugin "discord" with @openclaw/discord@${DISCORD_CORE_VERSION}.`,
        );
        expect(readPersistedInstalledPluginIndexInstallRecords({ env })?.discord?.source).toBe(
          "npm",
        );
        expect(fs.existsSync(path.join(checkoutPluginDir, "openclaw.plugin.json"))).toBe(true);
      } finally {
        closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(env));
      }
    },
  );

  it.each([
    {
      guard: "plugins.load.paths selects the checkout copy",
      hardlinkedManifest: false,
      plugins: (checkout: string) => ({
        load: { paths: [path.join(checkout, "extensions", "discord")] },
      }),
    },
    {
      guard: "plugins.load.paths contains a checkout copy whose manifest discovery rejects",
      hardlinkedManifest: true,
      plugins: (checkout: string) => ({ load: { paths: [path.join(checkout, "extensions")] } }),
    },
    {
      guard: "plugins.load.paths selects an entry file inside a checkout copy discovery rejects",
      hardlinkedManifest: true,
      plugins: (checkout: string) => ({
        load: { paths: [path.join(checkout, "extensions", "discord", "index.js")] },
      }),
    },
    {
      guard: "plugins.load.paths selects another Discord copy",
      hardlinkedManifest: false,
      plugins: (checkout: string) => {
        const selectedCopy = path.join(path.dirname(checkout), "selected-discord");
        writeDiscordPackage(selectedCopy, DISCORD_CORE_VERSION, "published");
        return { load: { paths: [selectedCopy] } };
      },
    },
    {
      guard: "plugins.entries.discord.enabled is false",
      hardlinkedManifest: false,
      plugins: () => ({ entries: { discord: { enabled: false } } }),
    },
  ])("keeps the Discord path record while $guard", async ({ hardlinkedManifest, plugins }) => {
    const { env, records, checkout } = await seedAbandonedCheckout({ hardlinkedManifest });
    try {
      await runUpdateFlow({
        flow: "update repair",
        cfg: { ...DISCORD_CHANNEL_CONFIG, plugins: plugins(checkout) },
        env,
        records,
      });
      expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
      expect(readPersistedInstalledPluginIndexInstallRecords({ env })?.discord).toEqual(
        records.discord,
      );

      const { convergence } = await runUpdateFlow({
        flow: "update repair",
        cfg: DISCORD_CHANNEL_CONFIG,
        env,
        records,
      });
      expect(mocks.installPluginFromNpmSpec).toHaveBeenCalledTimes(1);
      expect(convergence.repairedPluginIds).toEqual(["discord"]);
    } finally {
      closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(env));
    }
  });

  it.each([
    {
      failure: "the package install fails",
      checkoutLayout: "source" as const,
      update: undefined,
      installerWarning: `Failed to replace source-checkout copy of plugin "discord" with @openclaw/discord: npm install failed: EACCES`,
    },
    {
      failure: "the beta registry cannot be reached for a copy with channel metadata",
      checkoutLayout: "published" as const,
      update: { channel: "beta" as const },
      installerWarning:
        "Could not resolve @openclaw/discord@beta: getaddrinfo ENOTFOUND registry.npmjs.org",
    },
  ])(
    "retains the path record with a retry warning when $failure",
    async ({ checkoutLayout, update, installerWarning }) => {
      const { env, records, checkoutPluginDir } = await seedAbandonedCheckout({ checkoutLayout });
      mocks.installPluginFromNpmSpec.mockResolvedValue({
        ok: false,
        error: "npm install failed: EACCES",
      });
      mocks.resolveNpmSpecMetadata.mockResolvedValue({
        ok: false,
        category: "metadata-env",
        error: "getaddrinfo ENOTFOUND registry.npmjs.org",
      });
      const retryWarning = `Plugin "discord" still uses the OpenClaw source-checkout copy at ${checkoutPluginDir}. Run openclaw plugins install @openclaw/discord --force to replace it.`;
      try {
        const { convergence } = await runUpdateFlow({
          flow: "doctor",
          cfg: { ...DISCORD_CHANNEL_CONFIG, update },
          env,
          records,
        });

        expect(convergence.installRecords.discord).toEqual(records.discord);
        expect(readPersistedInstalledPluginIndexInstallRecords({ env })?.discord).toEqual(
          records.discord,
        );
        expect(convergence.errored).toBe(false);
        expect(convergence.warnings).toEqual(
          [installerWarning, retryWarning].map((message) => ({
            kind: "repair",
            pluginId: "discord",
            reason: message,
            message,
            guidance: ["Run `openclaw update repair` to retry plugin repair."],
          })),
        );
      } finally {
        closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(env));
      }
    },
  );

  it("defers the replacement while the core package swap is in progress", async () => {
    const { env, records } = await seedAbandonedCheckout();
    try {
      await withPluginCache(createPluginCache(), async () => {
        await repairMissingConfiguredPluginInstalls({
          cfg: DISCORD_CHANNEL_CONFIG,
          env: {
            ...env,
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
            OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR: "1",
          },
        });
      });
      expect(mocks.installPluginFromNpmSpec).not.toHaveBeenCalled();
      expect(readPersistedInstalledPluginIndexInstallRecords({ env })?.discord).toEqual(
        records.discord,
      );

      const { convergence } = await runUpdateFlow({
        flow: "doctor",
        cfg: DISCORD_CHANNEL_CONFIG,
        env,
        records,
      });
      expect(convergence.repairedPluginIds).toEqual(["discord"]);
    } finally {
      closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(env));
    }
  });

  it("converges once and leaves the replacement alone on the next repair", async () => {
    const { env, records } = await seedAbandonedCheckout();
    try {
      await runUpdateFlow({ flow: "doctor", cfg: DISCORD_CHANNEL_CONFIG, env, records });
      const { convergence } = await runUpdateFlow({
        flow: "doctor",
        cfg: DISCORD_CHANNEL_CONFIG,
        env,
        records,
      });

      expect(mocks.installPluginFromNpmSpec).toHaveBeenCalledTimes(1);
      expect(convergence.repairedPluginIds).toBeUndefined();
      expect(convergence.installRecords.discord).toMatchObject({
        source: "npm",
        version: DISCORD_CORE_VERSION,
      });
    } finally {
      closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(env));
    }
  });
});
