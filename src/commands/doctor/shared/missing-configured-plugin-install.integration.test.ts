import crypto from "node:crypto";
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../../config/types.plugins.js";
import * as temporaryState from "../../../infra/tmp-openclaw-dir.js";
import { withPluginInstallRoots } from "../../../plugins/install-root-context.js";
import { installPluginFromNpmSpec } from "../../../plugins/install.js";
import { readPersistedInstalledPluginIndex } from "../../../plugins/installed-plugin-index-store.js";
import {
  hasRetainedManagedNpmInstallMarker,
  resolveRetainedManagedNpmInstallPackageInfo,
} from "../../../plugins/managed-npm-retention.js";
import { createPluginCache, withPluginCache } from "../../../plugins/plugin-cache.js";
import { seedInstalledPluginIndex } from "../../../plugins/test-helpers/installed-plugin-index.js";
import {
  packPlugins,
  startStaticRegistry,
} from "../../../plugins/test-helpers/npm-registry-fixtures.js";
import * as processExecution from "../../../process/exec.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  detectConfiguredPluginInstallHealthIssues,
  repairMissingConfiguredPluginInstalls,
} from "./missing-configured-plugin-install.js";

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

describe("Doctor same-version required dependency repair", () => {
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
          await fs.mkdir(control, { mode: 0o700 });
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
              await fs.rm(path.join(packageInfo.projectRoot, "node_modules", dependency), {
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
              const configBefore = await fs.readFile(state.configPath, "utf8");
              const indexBefore = await readPersistedInstalledPluginIndex();
              const projectInputs = ["package.json", "package-lock.json"];
              const projectInputsBefore = await Promise.all(
                projectInputs.map((file) =>
                  fs.readFile(path.join(packageInfo.projectRoot, file), "utf8"),
                ),
              );
              const payloadPaths = ["package.json", "openclaw.plugin.json", "dist/index.js"];
              const payloadBefore = await Promise.all(
                payloadPaths.map((file) =>
                  fs.readFile(path.join(installed.targetDir, file), "utf8"),
                ),
              );
              const projectsBefore = (await fs.readdir(path.join(npmDir, "projects"))).toSorted();
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
                    argv[0] === "npm" &&
                    argv[1] === "install" &&
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
                    argv[0] === "npm" &&
                    argv[1] === "install" &&
                    !argv.includes("--package-lock-only") &&
                    result.code === 0
                  ) {
                    npmInstalls++;
                    if (scenario === "hollow-replacement") {
                      const stageDir = typeof options === "object" ? options.cwd : undefined;
                      if (!stageDir) {
                        throw new Error("Missing npm staging directory");
                      }
                      await fs.rm(path.join(stageDir, "node_modules", dependency), {
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
                      await fs.readFile(
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
                expect((await fs.readdir(path.join(npmDir, "projects"))).toSorted()).toEqual(
                  projectsBefore,
                );
              }
              expect(hasRetainedManagedNpmInstallMarker(installed.targetDir)).toBe(
                scenario === "repaired",
              );
              expect(await fs.readFile(state.configPath, "utf8")).toBe(configBefore);
              expect(
                await Promise.all(
                  projectInputs.map((file) =>
                    fs.readFile(path.join(packageInfo.projectRoot, file), "utf8"),
                  ),
                ),
              ).toEqual(projectInputsBefore);
              expect(
                await Promise.all(
                  payloadPaths.map((file) =>
                    fs.readFile(path.join(installed.targetDir, file), "utf8"),
                  ),
                ),
              ).toEqual(payloadBefore);
              await expect(
                fs.stat(path.join(packageInfo.projectRoot, "node_modules", dependency)),
              ).rejects.toMatchObject({ code: "ENOENT" });
            },
          );
        },
      );
    },
  );
});
