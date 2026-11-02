import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
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
  resolveRetainedManagedNpmInstallPackageInfo as managedPackage,
} from "../../../plugins/managed-npm-retention.js";
import { createPluginCache, withPluginCache } from "../../../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../../../plugins/plugin-metadata-lifecycle.js";
import { seedInstalledPluginIndex } from "../../../plugins/test-helpers/installed-plugin-index.js";
import {
  registryPackages,
  startStaticRegistry,
} from "../../../plugins/test-helpers/npm-registry-fixtures.js";
import * as processExecution from "../../../process/exec.js";
import { npmCommandArgs } from "../../../test-utils/npm-command.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { writePluginJson as writeJson } from "./missing-configured-plugin-install.fixtures.test-support.js";
import {
  configuredPluginInstallIssueToRepairEffect as repairEffect,
  detectConfiguredPluginInstallHealthIssues,
  repairMissingConfiguredPluginInstalls,
} from "./missing-configured-plugin-install.js";

async function readFiles(root: string, files: string[]) {
  return Promise.all(files.map((file) => fsp.readFile(path.join(root, file), "utf8")));
}

async function readJson(root: string): Promise<unknown> {
  return JSON.parse(await fsp.readFile(path.join(root, "package.json"), "utf8"));
}

async function install(params: Parameters<typeof installPluginFromNpmSpec>[0]) {
  const result = await installPluginFromNpmSpec(params);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result;
}

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
    (scenario) =>
      withOpenClawTestState(
        {
          label: `doctor-dependencies-${scenario}`,
          env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
        },
        async (state) => {
          const control = state.path("control");
          await fsp.mkdir(control, { mode: 0o700 });
          vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
          const packageName = `doctor-dependency-${crypto.randomUUID()}`;
          const dependency = "doctor-required-runtime";
          const packages = await registryPackages(state.path("packages"), [
            {
              packageName,
              dependencies: { [dependency]: "1.0.0" },
              indexJs: `export default { id: ${JSON.stringify(packageName)}, register() {} };\n`,
            },
            { packageName: dependency },
          ]);
          const registry = await startStaticRegistry(packages, servers);
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
              const first = await install(installParams);
              // Corrupt a same-version generation, not just the original legacy project.
              const installed = await install({ ...installParams, mode: "update" });
              expect(installed.targetDir).not.toBe(first.targetDir);
              const packageInfo = managedPackage(installed.targetDir)!;
              const dependencyDir = path.join(packageInfo.projectRoot, "node_modules", dependency);
              await fsp.rm(dependencyDir, { recursive: true });
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
                  integrity: packages[0]!.versions[0]!.integrity,
                },
              };
              await state.writeConfig(cfg);
              await seedInstalledPluginIndex(records, { config: cfg, env: process.env });
              const projectInputs = ["package.json", "package-lock.json"];
              const payloadPaths = ["package.json", "openclaw.plugin.json", "dist/index.js"];
              const immutableSnapshot = async () => ({
                config: await fsp.readFile(state.configPath, "utf8"),
                project: await readFiles(packageInfo.projectRoot, projectInputs),
                payload: await readFiles(installed.targetDir, payloadPaths),
                ...(scenario === "repaired"
                  ? {}
                  : {
                      index: await readPersistedInstalledPluginIndex(),
                      projects: (await fsp.readdir(path.join(npmDir, "projects"))).toSorted(),
                    }),
              });
              const immutableBefore = await immutableSnapshot();
              const health = () =>
                withPluginCache(createPluginCache(), () =>
                  detectConfiguredPluginInstallHealthIssues({ cfg }),
                );
              expect(await health()).toContainEqual(
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
                  const isInstall =
                    npmCommandArgs(argv)?.[0] === "install" &&
                    !argv.includes("--package-lock-only");
                  if (scenario === "killed-npm" && isInstall) {
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
                  if (isInstall && result.code === 0) {
                    npmInstalls++;
                    if (scenario === "hollow-replacement") {
                      const stageDir = typeof options === "object" ? options.cwd : undefined;
                      if (!stageDir) {
                        throw new Error("Missing npm staging directory");
                      }
                      await fsp.rm(path.join(stageDir, "node_modules", dependency), {
                        recursive: true,
                      });
                    }
                  }
                  return result;
                },
              );
              const refusal = new Error("Doctor cutover refused");
              const repair = () =>
                withPluginCache(createPluginCache(), () =>
                  repairMissingConfiguredPluginInstalls({
                    cfg,
                    timeoutMs: 120_000,
                    workTimeoutMs: null,
                    beforePersistentEffect: async () => {
                      await Promise.resolve();
                      if (scenario === "effect-refused") {
                        throw refusal;
                      }
                    },
                    onCapabilityConsent: async (review) => ({ reviewToken: review.reviewToken }),
                  }),
                );
              if (scenario === "effect-refused") {
                await expect(repair()).rejects.toBe(refusal);
              } else {
                const result = await repair();
                if (scenario === "repaired") {
                  expect(result.repairedPluginIds).toEqual([packageName]);
                  const next = result.records[packageName]!;
                  expect(next.installPath).not.toBe(installed.targetDir);
                  expect(next).toMatchObject({
                    version: "1.0.0",
                    integrity: records[packageName]!.integrity,
                  });
                  const nextProject = managedPackage(next.installPath!)!;
                  expect(
                    await readJson(path.join(nextProject.projectRoot, "node_modules", dependency)),
                  ).toMatchObject({ name: dependency });
                  expect((await readPersistedInstalledPluginIndex())?.installRecords).toEqual(
                    result.records,
                  );
                  expect(await health()).toEqual([]);
                } else {
                  expect(result.failedPluginIds).toEqual([packageName]);
                  expect(result.records).toEqual(records);
                  expect(result.warnings.join("\n")).toContain(
                    scenario === "killed-npm" ? "npm install failed" : dependency,
                  );
                }
              }
              expect(npmInstalls).toBe(scenario === "effect-refused" ? 0 : 1);
              expect(killedNpm).toBe(scenario === "killed-npm");
              expect(hasRetainedManagedNpmInstallMarker(installed.targetDir)).toBe(
                scenario === "repaired",
              );
              expect(await immutableSnapshot()).toEqual(immutableBefore);
              await expect(fsp.stat(dependencyDir)).rejects.toMatchObject({
                code: "ENOENT",
              });
            },
          );
        },
      ),
  );
});

describe("configured plugin install health for explicit load paths", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(clearPluginMetadataLifecycleCaches);

  async function createLoadPathFixture(
    id: "kilocode" | "opencode-go" | "gmail",
    { malformed = false, packaged = false } = {},
  ) {
    const rootDir = tempDirs.make("openclaw-load-path-");
    const bundled = id === "opencode-go";
    const bundledDir = path.join(rootDir, "dist/extensions");
    const pluginDir = path.join(bundled ? bundledDir : rootDir, id);
    const stateDir = path.join(rootDir, "state");
    const cfg: OpenClawConfig = packaged
      ? { auth: { profiles: { "opencode-go:default": { provider: id, mode: "api_key" } } } }
      : {
          plugins: {
            load: { paths: [pluginDir] },
            ...(id !== "kilocode" ? { entries: { [id]: { enabled: true } } } : {}),
          },
        };
    const env: NodeJS.ProcessEnv = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledDir,
      OPENCLAW_STATE_DIR: stateDir,
      VITEST: "true",
      ...(bundled
        ? {
            OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
            OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          }
        : { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }),
      ...(id === "kilocode" ? { KILOCODE_API_KEY: "test-key" } : {}),
    };
    const seedPath = (installPath = pluginDir) =>
      seedInstalledPluginIndex(
        {
          [id]: { source: "path", sourcePath: installPath, installPath },
        },
        { config: cfg, env },
      );
    if (id === "gmail") {
      fs.mkdirSync(path.join(pluginDir, ".codex-plugin"), { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, ".codex-plugin/plugin.json"),
        malformed ? "{not-json" : JSON.stringify({ name: id, apps: "./.app.json" }),
        "utf8",
      );
      writeJson(pluginDir, ".app.json", { apps: { gmail: { id: "connector_test" } } });
      await seedPath();
    } else {
      fs.mkdirSync(path.join(pluginDir, "dist"), { recursive: true });
      const entry = bundled ? "index.js" : "dist/index.js";
      fs.writeFileSync(path.join(pluginDir, entry), "export default {};\n", "utf8");
      writeJson(pluginDir, "package.json", {
        name: `@openclaw/${id}-provider`,
        version: bundled ? "2026.8.1" : "2026.7.1",
        openclaw: bundled
          ? {
              extensions: ["./index.js"],
              build: { openclawVersion: "2026.8.1" },
            }
          : { extensions: ["./index.ts"], runtimeExtensions: ["./dist/index.js"] },
      });
      writeJson(pluginDir, "openclaw.plugin.json", {
        id,
        enabledByDefault: true,
        providers: [id],
        ...(bundled ? { activation: { onStartup: false } } : {}),
        configSchema: { type: "object" },
      });
    }
    if (packaged) {
      const home = path.join(rootDir, "home");
      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(stateDir, { recursive: true });
      writeJson(stateDir, "openclaw.json", cfg);
      Object.assign(env, {
        HOME: home,
        USERPROFILE: home,
        OPENCLAW_HOME: home,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        NPM_CONFIG_REGISTRY: "http://127.0.0.1:9",
        npm_config_registry: "http://127.0.0.1:9",
        XDG_CONFIG_HOME: path.join(rootDir, "xdg-config"),
      });
    }
    return { rootDir, pluginDir, cfg, env, seedPath };
  }

  it("uses configured selection when a load path keeps bundled origin", async () => {
    const { rootDir, cfg, env, seedPath } = await createLoadPathFixture("opencode-go");
    await seedPath(path.join(rootDir, "removed-plugin"));

    expect(await detectConfiguredPluginInstallHealthIssues({ cfg, env })).toStrictEqual([]);

    const repair = await repairMissingConfiguredPluginInstalls({ cfg, env });
    expect(repair.records).not.toHaveProperty("opencode-go");
    expect(await loadInstalledPluginIndexInstallRecords({ env })).not.toHaveProperty("opencode-go");
  });

  it.each(["kilocode", "gmail", "opencode-go"] as const)(
    "keeps available %s without reinstalling",
    async (id) => {
      const { rootDir, cfg, env, pluginDir } = await createLoadPathFixture(id, {
        packaged: id === "opencode-go",
      });
      const records: Record<string, PluginInstallRecord> = {
        kilocode: {
          source: "npm",
          spec: "@openclaw/kilocode-provider",
          installPath: path.join(rootDir, "missing-npm-package"),
        },
      };
      if (id === "kilocode") {
        await seedInstalledPluginIndex(records, { config: cfg, env });
      }
      expect(await detectConfiguredPluginInstallHealthIssues({ cfg, env })).toStrictEqual([]);
      const repair = await repairMissingConfiguredPluginInstalls({ cfg, env });
      expect(repair).toMatchObject({ changes: [], warnings: [] });
      if (id === "kilocode") {
        expect(repair).toMatchObject({ records });
        expect(await loadInstalledPluginIndexInstallRecords({ env })).toEqual(records);
      } else if (id === "gmail") {
        expect(repair.records.gmail).toMatchObject({ source: "path", installPath: pluginDir });
        expect(await loadInstalledPluginIndexInstallRecords({ env })).toHaveProperty("gmail");
      } else {
        expect(Object.keys(repair.records)).toStrictEqual([]);
        expect(Object.getPrototypeOf(repair.records)).toBeNull();
      }
    },
  );

  it("classifies a malformed Codex bundle manifest as repairable", async () => {
    const { cfg, env } = await createLoadPathFixture("gmail", { malformed: true });

    const issues = await detectConfiguredPluginInstallHealthIssues({ cfg, env });
    expect(issues).toEqual([
      expect.objectContaining({ kind: "missing-installed-payload", pluginId: "gmail" }),
    ]);
    expect(repairEffect(expectDefined(issues[0], "configured plugin issue"))).toEqual({
      kind: "package",
      action: "would-reinstall-configured-plugin",
      target: "gmail",
      dryRunSafe: false,
    });
  });
});
