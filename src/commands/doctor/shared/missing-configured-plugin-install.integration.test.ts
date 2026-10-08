import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import * as temporaryState from "../../../infra/tmp-openclaw-dir.js";
import { withPluginInstallRoots } from "../../../plugins/install-root-context.js";
import { installPluginFromNpmSpec } from "../../../plugins/install.js";
import { loadInstalledPluginIndexInstallRecords } from "../../../plugins/installed-plugin-index-records.js";
import { readPersistedInstalledPluginIndex } from "../../../plugins/installed-plugin-index-store.js";
import {
  hasRetainedManagedNpmInstallMarker,
  resolveRetainedManagedNpmInstallPackageInfo,
} from "../../../plugins/managed-npm-retention.js";
import { loadManifestMetadataSnapshot } from "../../../plugins/manifest-contract-eligibility.js";
import { createPluginCache, withPluginCache } from "../../../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../../../plugins/plugin-metadata-lifecycle.js";
import { seedInstalledPluginIndex } from "../../../plugins/test-helpers/installed-plugin-index.js";
import {
  packPlugins,
  startStaticRegistry,
} from "../../../plugins/test-helpers/npm-registry-fixtures.js";
import * as processExecution from "../../../process/exec.js";
import { npmCommandArgs } from "../../../test-utils/npm-command.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  configuredPluginInstallIssueToRepairEffect,
  detectConfiguredPluginInstallHealthIssues,
  repairMissingConfiguredPluginInstalls,
} from "./missing-configured-plugin-install.js";

describe("Doctor same-version required dependency repair", () => {
  const servers: http.Server[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it.each(["repaired", "hollow-replacement", "killed-npm", "effect-refused"] as const)(
    "%s preserves the recorded generation and configuration through the real updater",
    { timeout: 180_000 },
    async (scenario) => {
      await withOpenClawTestState(
        {
          label: `doctor-dependencies-${scenario}`,
          env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
        },
        async (state) => {
          const control = state.path("control");
          await fsPromises.mkdir(control, { mode: 0o700 });
          vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
          const packageName = `doctor-dependency-${crypto.randomUUID()}`;
          const dependency = "doctor-required-runtime";
          const versions = await packPlugins(state.path("packages"), [
            {
              packageName,
              dependencies: { [dependency]: "1.0.0" },
              indexJs: `export default { id: ${JSON.stringify(packageName)}, register() {} };\n`,
            },
          ]);
          const dependencyVersions = await packPlugins(state.path("dependencies"), [
            { packageName: dependency },
          ]);
          const registry = await startStaticRegistry(
            [
              { packageName, latest: "1.0.0", versions },
              { packageName: dependency, latest: "1.0.0", versions: dependencyVersions },
            ],
            servers,
          );
          vi.stubEnv("NPM_CONFIG_REGISTRY", registry);
          vi.stubEnv("npm_config_registry", registry);
          vi.stubEnv("NPM_CONFIG_CACHE", state.path("npm-cache"));
          const npmDir = state.statePath("npm");
          await withPluginInstallRoots(
            {
              npmDir,
              extensionsDir: state.statePath("extensions"),
              gitDir: state.statePath("git"),
              stateDir: state.stateDir,
            },
            async () => {
              const installParams = {
                npmDir,
                spec: `${packageName}@1.0.0`,
                timeoutMs: 120_000,
                logger: { info() {}, warn() {} },
              };
              const first = await installPluginFromNpmSpec(installParams);
              if (!first.ok) {
                throw new Error(first.error);
              }
              // Corrupt a same-version generation, not just the original legacy project.
              const installed = await installPluginFromNpmSpec({
                ...installParams,
                mode: "update",
              });
              if (!installed.ok) {
                throw new Error(installed.error);
              }
              expect(installed.targetDir).not.toBe(first.targetDir);
              const packageInfo = resolveRetainedManagedNpmInstallPackageInfo(installed.targetDir)!;
              await fsPromises.rm(path.join(packageInfo.projectRoot, "node_modules", dependency), {
                recursive: true,
              });
              const cfg: OpenClawConfig = {
                plugins: { allow: [packageName], entries: { [packageName]: { enabled: true } } },
              };
              const records: Record<string, PluginInstallRecord> = {
                [packageName]: {
                  source: "npm",
                  spec: `${packageName}@1.0.0`,
                  version: "1.0.0",
                  installPath: installed.targetDir,
                  resolvedName: packageName,
                  resolvedVersion: "1.0.0",
                  resolvedSpec: `${packageName}@1.0.0`,
                  integrity: versions[0]!.integrity,
                },
              };
              await state.writeConfig(cfg);
              await seedInstalledPluginIndex(records, { config: cfg, env: process.env });
              const configBefore = await fsPromises.readFile(state.configPath, "utf8");
              const indexBefore = await readPersistedInstalledPluginIndex();
              const projectInputs = ["package.json", "package-lock.json"];
              const projectInputsBefore = await Promise.all(
                projectInputs.map((file) =>
                  fsPromises.readFile(path.join(packageInfo.projectRoot, file), "utf8"),
                ),
              );
              const payloadPaths = ["package.json", "openclaw.plugin.json", "dist/index.js"];
              const payloadBefore = await Promise.all(
                payloadPaths.map((file) =>
                  fsPromises.readFile(path.join(installed.targetDir, file), "utf8"),
                ),
              );
              const projectsBefore = (
                await fsPromises.readdir(path.join(npmDir, "projects"))
              ).toSorted();
              const issues = await withPluginCache(createPluginCache(), () =>
                detectConfiguredPluginInstallHealthIssues({ cfg }),
              );
              expect(issues).toContainEqual(
                expect.objectContaining({
                  kind: "missing-required-dependencies",
                  pluginId: packageName,
                  missingRequired: [dependency],
                }),
              );
              let npmInstalls = 0;
              let killedNpm = false;
              const realRun = processExecution.runCommandWithTimeout;
              vi.spyOn(processExecution, "runCommandWithTimeout").mockImplementation(
                async (...args) => {
                  const [argv, options] = args;
                  if (
                    scenario === "killed-npm" &&
                    npmCommandArgs(argv)?.[0] === "install" &&
                    !argv.includes("--package-lock-only")
                  ) {
                    const installOptions =
                      typeof options === "number" ? { timeoutMs: options } : options;
                    let npmPid: number | undefined;
                    const killDuringDownload = (request: http.IncomingMessage) => {
                      if (!killedNpm && npmPid && request.url?.endsWith(".tgz")) {
                        process.kill(npmPid, "SIGKILL");
                        killedNpm = true;
                      }
                    };
                    const server = servers.at(-1)!;
                    server.prependListener("request", killDuringDownload);
                    try {
                      const result = await realRun(argv, {
                        ...installOptions,
                        input: "",
                        env: {
                          ...installOptions.env,
                          NPM_CONFIG_CACHE: state.path("repair-npm-cache"),
                          npm_config_cache: state.path("repair-npm-cache"),
                        },
                        beforeInput: (pid, command) => {
                          npmPid = pid;
                          installOptions.beforeInput?.(pid, command);
                        },
                      });
                      expect(result.signal).toBe("SIGKILL");
                      npmInstalls++;
                      return result;
                    } finally {
                      server.off("request", killDuringDownload);
                    }
                  }
                  const result = await realRun(...args);
                  if (
                    npmCommandArgs(argv)?.[0] === "install" &&
                    !argv.includes("--package-lock-only") &&
                    result.code === 0
                  ) {
                    npmInstalls++;
                    if (scenario === "hollow-replacement") {
                      const stageDir = typeof options === "object" ? options.cwd : undefined;
                      if (!stageDir) {
                        throw new Error("Missing npm staging directory");
                      }
                      await fsPromises.rm(path.join(stageDir, "node_modules", dependency), {
                        recursive: true,
                      });
                    }
                  }
                  return result;
                },
              );
              const refusal = new Error("Doctor cutover refused");
              const beforePersistentEffect = vi.fn(async () => {
                await Promise.resolve();
                if (scenario === "effect-refused") {
                  throw refusal;
                }
              });
              const repair = () =>
                withPluginCache(createPluginCache(), () =>
                  repairMissingConfiguredPluginInstalls({
                    cfg,
                    timeoutMs: 120_000,
                    workTimeoutMs: null,
                    beforePersistentEffect,
                    onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
                  }),
                );
              if (scenario === "effect-refused") {
                await expect(repair()).rejects.toBe(refusal);
                expect(npmInstalls).toBe(0);
              } else {
                const result = await repair();
                expect(npmInstalls).toBe(1);
                if (scenario === "repaired") {
                  expect(result.repairedPluginIds).toEqual([packageName]);
                  const next = result.records[packageName]!;
                  expect(next.installPath).not.toBe(installed.targetDir);
                  expect(next.version).toBe("1.0.0");
                  expect(next.integrity).toBe(records[packageName]!.integrity);
                  const nextProject = resolveRetainedManagedNpmInstallPackageInfo(
                    next.installPath!,
                  )!;
                  expect(
                    JSON.parse(
                      await fsPromises.readFile(
                        path.join(
                          nextProject.projectRoot,
                          "node_modules",
                          dependency,
                          "package.json",
                        ),
                        "utf8",
                      ),
                    ).name,
                  ).toBe(dependency);
                  expect((await readPersistedInstalledPluginIndex())?.installRecords).toEqual(
                    result.records,
                  );
                  expect(
                    await withPluginCache(createPluginCache(), () =>
                      detectConfiguredPluginInstallHealthIssues({ cfg }),
                    ),
                  ).toEqual([]);
                } else {
                  expect(result.failedPluginIds).toEqual([packageName]);
                  expect(result.records).toEqual(records);
                  expect(result.warnings.join("\n")).toContain(
                    scenario === "killed-npm" ? "npm install failed" : dependency,
                  );
                }
              }
              expect(killedNpm).toBe(scenario === "killed-npm");
              if (scenario !== "repaired") {
                expect(await readPersistedInstalledPluginIndex()).toEqual(indexBefore);
                expect(
                  (await fsPromises.readdir(path.join(npmDir, "projects"))).toSorted(),
                ).toEqual(projectsBefore);
              }
              expect(hasRetainedManagedNpmInstallMarker(installed.targetDir)).toBe(
                scenario === "repaired",
              );
              expect(await fsPromises.readFile(state.configPath, "utf8")).toBe(configBefore);
              expect(
                await Promise.all(
                  projectInputs.map((file) =>
                    fsPromises.readFile(path.join(packageInfo.projectRoot, file), "utf8"),
                  ),
                ),
              ).toEqual(projectInputsBefore);
              expect(
                await Promise.all(
                  payloadPaths.map((file) =>
                    fsPromises.readFile(path.join(installed.targetDir, file), "utf8"),
                  ),
                ),
              ).toEqual(payloadBefore);
              await expect(
                fsPromises.stat(path.join(packageInfo.projectRoot, "node_modules", dependency)),
              ).rejects.toMatchObject({ code: "ENOENT" });
            },
          );
        },
      );
    },
  );
});

describe("configured plugin install health for explicit load paths", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    clearPluginMetadataLifecycleCaches();
  });

  function writeProviderPlugin(rootDir: string): void {
    fs.mkdirSync(path.join(rootDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "dist", "index.js"), "export default {};\n", "utf8");
    fs.writeFileSync(
      path.join(rootDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/kilocode-provider",
        version: "2026.7.1",
        openclaw: { extensions: ["./index.ts"], runtimeExtensions: ["./dist/index.js"] },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "kilocode",
        enabledByDefault: true,
        providers: ["kilocode"],
        configSchema: { type: "object", properties: {} },
      }),
      "utf8",
    );
  }

  async function writePathInstallRecord(params: {
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    pluginId: string;
    installPath: string;
  }): Promise<void> {
    await seedInstalledPluginIndex(
      {
        [params.pluginId]: {
          source: "path",
          sourcePath: params.installPath,
          installPath: params.installPath,
        },
      },
      { config: params.cfg, env: params.env },
    );
  }

  async function createConfiguredCodexBundleFixture(manifestState: "valid" | "malformed") {
    const rootDir = tempDirs.make(`openclaw-codex-${manifestState}-`);
    const pluginDir = path.join(rootDir, "gmail");
    fs.mkdirSync(path.join(pluginDir, ".codex-plugin"), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, ".codex-plugin", "plugin.json"),
      manifestState === "valid"
        ? JSON.stringify({ name: "gmail", apps: "./.app.json" })
        : "{not-json",
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginDir, ".app.json"),
      JSON.stringify({ apps: { gmail: { id: "connector_test" } } }),
      "utf8",
    );
    const cfg: OpenClawConfig = {
      plugins: { load: { paths: [pluginDir] }, entries: { gmail: { enabled: true } } },
    };
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(rootDir, "bundled"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
      VITEST: "true",
    };
    await writePathInstallRecord({ cfg, env, pluginId: "gmail", installPath: pluginDir });
    return { cfg, env, pluginDir };
  }

  function writeBundledOpenCodeGoPlugin(bundledPluginsDir: string): void {
    const pluginDir = path.join(bundledPluginsDir, "opencode-go");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "index.js"), "export default {};\n", "utf8");
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/opencode-go-provider",
        version: "2026.8.1",
        openclaw: {
          extensions: ["./index.js"],
          install: {
            clawhubSpec: "clawhub:@openclaw/opencode-go-provider",
            npmSpec: "@openclaw/opencode-go-provider",
            defaultChoice: "npm",
          },
          build: { openclawVersion: "2026.8.1" },
          release: { publishToClawHub: true, publishToNpm: true },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "opencode-go",
        activation: { onStartup: false },
        enabledByDefault: true,
        providers: ["opencode-go"],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
      "utf8",
    );
  }

  function createProviderFixture() {
    const rootDir = tempDirs.make("openclaw-load-path-provider-");
    const pluginDir = path.join(rootDir, "configured-plugin");
    writeProviderPlugin(pluginDir);
    const cfg: OpenClawConfig = {
      plugins: {
        load: { paths: [pluginDir] },
      },
    };
    const env = {
      KILOCODE_API_KEY: "test-key",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(rootDir, "bundled"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
      VITEST: "true",
    };
    return { rootDir, pluginDir, cfg, env };
  }

  it("uses configured selection when a load path keeps bundled origin", async () => {
    const rootDir = tempDirs.make("openclaw-stale-bundled-record-");
    const bundledPluginsDir = path.join(rootDir, "dist", "extensions");
    const pluginDir = path.join(bundledPluginsDir, "opencode-go");
    const stalePath = path.join(rootDir, "removed-plugin");
    writeBundledOpenCodeGoPlugin(bundledPluginsDir);
    const cfg: OpenClawConfig = {
      plugins: { load: { paths: [pluginDir] }, entries: { "opencode-go": { enabled: true } } },
    };
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
      OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      VITEST: "true",
    };
    await writePathInstallRecord({ cfg, env, pluginId: "opencode-go", installPath: stalePath });

    const snapshot = loadManifestMetadataSnapshot({ config: cfg, env });
    expect(snapshot.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "opencode-go", origin: "bundled", rootDir: pluginDir }),
      ]),
    );
    expect(snapshot.discovery?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rootDir: pluginDir, origin: "bundled", configSelected: true }),
      ]),
    );
    expect(await detectConfiguredPluginInstallHealthIssues({ cfg, env })).toStrictEqual([]);

    const repair = await repairMissingConfiguredPluginInstalls({ cfg, env });
    expect(repair.records).not.toHaveProperty("opencode-go");
    expect(await loadInstalledPluginIndexInstallRecords({ env })).not.toHaveProperty("opencode-go");
  });

  it("keeps an env-selected load-path provider despite a missing npm shadow", async () => {
    const { rootDir, cfg, env } = createProviderFixture();
    const records: Record<string, PluginInstallRecord> = {
      kilocode: {
        source: "npm",
        spec: "@openclaw/kilocode-provider",
        installPath: path.join(rootDir, "missing-npm-package"),
      },
    };
    await seedInstalledPluginIndex(records, { config: cfg, env });
    const snapshot = loadManifestMetadataSnapshot({ config: cfg, env });
    expect(snapshot.plugins.map((plugin) => plugin.id)).toContain("kilocode");
    expect(await detectConfiguredPluginInstallHealthIssues({ cfg, env })).toStrictEqual([]);
    const repair = await repairMissingConfiguredPluginInstalls({ cfg, env });
    expect(repair).toMatchObject({ changes: [], records, warnings: [] });
    expect(await loadInstalledPluginIndexInstallRecords({ env })).toEqual(records);
  });

  it("keeps a configured Gmail Codex app bundle without package.json", async () => {
    const { cfg, env, pluginDir } = await createConfiguredCodexBundleFixture("valid");

    const snapshot = loadManifestMetadataSnapshot({ config: cfg, env });
    expect(snapshot.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gmail",
          origin: "config",
          rootDir: pluginDir,
          bundleFormat: "codex",
        }),
      ]),
    );
    expect(await detectConfiguredPluginInstallHealthIssues({ cfg, env })).toStrictEqual([]);

    const repair = await repairMissingConfiguredPluginInstalls({ cfg, env });
    expect(repair).toMatchObject({ changes: [], warnings: [] });
    expect(repair.records.gmail).toMatchObject({ source: "path", installPath: pluginDir });
    expect(await loadInstalledPluginIndexInstallRecords({ env })).toHaveProperty("gmail");
  });

  it("classifies a malformed Codex bundle manifest as repairable", async () => {
    const { cfg, env } = await createConfiguredCodexBundleFixture("malformed");

    const issues = await detectConfiguredPluginInstallHealthIssues({ cfg, env });
    expect(issues).toEqual([
      expect.objectContaining({ kind: "missing-installed-payload", pluginId: "gmail" }),
    ]);
    expect(
      configuredPluginInstallIssueToRepairEffect(
        expectDefined(issues[0], "configured plugin issue"),
      ),
    ).toEqual({
      kind: "package",
      action: "would-reinstall-configured-plugin",
      target: "gmail",
      dryRunSafe: false,
    });
  });

  it("discovers packaged OpenCode Go before configured-plugin repair", async () => {
    const rootDir = tempDirs.make("openclaw-bundled-opencode-go-");
    const homeDir = path.join(rootDir, "home");
    const stateDir = path.join(rootDir, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const bundledPluginsDir = path.join(rootDir, "dist", "extensions");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    writeBundledOpenCodeGoPlugin(bundledPluginsDir);

    const cfg = {
      auth: {
        profiles: { "opencode-go:default": { provider: "opencode-go", mode: "api_key" as const } },
      },
    };
    fs.writeFileSync(configPath, `${JSON.stringify(cfg)}\n`, "utf8");
    const env = {
      HOME: homeDir,
      USERPROFILE: homeDir,
      OPENCLAW_HOME: homeDir,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      NPM_CONFIG_REGISTRY: "http://127.0.0.1:9",
      npm_config_registry: "http://127.0.0.1:9",
      XDG_CONFIG_HOME: path.join(rootDir, "xdg-config"),
      VITEST: "true",
    };
    const snapshot = loadManifestMetadataSnapshot({ config: cfg, env });
    expect(snapshot.plugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "opencode-go", origin: "bundled" })]),
    );

    const issues = await detectConfiguredPluginInstallHealthIssues({ cfg, env });
    expect(issues).toStrictEqual([]);

    const repair = await repairMissingConfiguredPluginInstalls({ cfg, env });
    expect(repair).toMatchObject({ changes: [], warnings: [] });
    expect(Object.keys(repair.records)).toStrictEqual([]);
    expect(Object.getPrototypeOf(repair.records)).toBeNull();
  });
});
