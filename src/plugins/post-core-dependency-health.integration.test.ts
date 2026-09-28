import crypto from "node:crypto";
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { preparePostCorePluginConfig } from "../cli/update-cli/update-command-config.js";
import { updatePluginsAfterCoreUpdate } from "../cli/update-cli/update-command-plugins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import * as temporaryState from "../infra/tmp-openclaw-dir.js";
import * as processExecution from "../process/exec.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolvePluginNpmProjectDir } from "./install-paths.js";
import { withPluginInstallRoots } from "./install-root-context.js";
import { installPluginFromNpmSpec } from "./install.js";
import { readPersistedInstalledPluginIndexInstallRecords } from "./installed-plugin-index-records.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { seedInstalledPluginIndex } from "./test-helpers/installed-plugin-index.js";
import { packPlugins, startStaticRegistry } from "./test-helpers/npm-registry-fixtures.js";

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

describe("post-core update required dependency publication", () => {
  const payloads = [
    "missing",
    "empty",
    "ancestor",
    "outside-symlink",
    "empty-manifest",
    "malformed-manifest",
    "hoisted",
    "optional",
  ] as const;
  it.each([
    ...payloads.map((payload) => ({
      payload,
      workBudget: "default",
      workTimeoutMs: undefined as number | null | undefined,
      expectedTimeoutMs: 120_000 as number | undefined,
    })),
    { payload: "missing", workBudget: "finite", workTimeoutMs: 90_000, expectedTimeoutMs: 90_000 },
    { payload: "missing", workBudget: "null", workTimeoutMs: null, expectedTimeoutMs: undefined },
    { payload: "hoisted", workBudget: "finite", workTimeoutMs: 90_000, expectedTimeoutMs: 90_000 },
    { payload: "optional", workBudget: "null", workTimeoutMs: null, expectedTimeoutMs: undefined },
  ] as const)(
    "handles a $payload payload after real npm success without losing the previous installation ($workBudget work budget)",
    { timeout: 180_000 },
    async ({ payload, workTimeoutMs, expectedTimeoutMs }) => {
      await withOpenClawTestState(
        {
          label: `post-core-dependency-${payload}`,
          env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
        },
        async (state) => {
          const control = state.path("control");
          await fs.mkdir(control, { mode: 0o700 });
          vi.spyOn(temporaryState, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
          const packageName = `dependency-owner-${crypto.randomUUID()}`;
          const dependency = "fixture-required-runtime";
          const indexJs = `export default { id: ${JSON.stringify(packageName)}, register() {} };\n`;
          const versions = await packPlugins(state.path("packages"), [
            { packageName, version: "1.0.0", indexJs },
            {
              packageName,
              version: "2.0.0",
              indexJs,
              dependencies: { [dependency]: "1.0.0" },
              ...(payload === "optional"
                ? { optionalDependencies: { [dependency]: "1.0.0" } }
                : {}),
            },
          ]);
          const dependencyVersions = await packPlugins(state.path("dependencies"), [
            { packageName: dependency },
          ]);
          const registry = await startStaticRegistry(
            [
              { packageName, latest: "2.0.0", versions },
              { packageName: dependency, latest: "1.0.0", versions: dependencyVersions },
            ],
            servers,
          );
          vi.stubEnv("NPM_CONFIG_REGISTRY", registry);
          vi.stubEnv("npm_config_registry", registry);
          vi.stubEnv("NPM_CONFIG_CACHE", state.path("npm-cache"));
          const npmDir = state.statePath("npm");
          const roots = {
            npmDir,
            extensionsDir: state.statePath("extensions"),
            gitDir: state.statePath("git"),
            stateDir: state.stateDir,
          };
          await withPluginInstallRoots(roots, async () => {
            const installed = await installPluginFromNpmSpec({
              npmDir,
              spec: `${packageName}@1.0.0`,
              timeoutMs: 120_000,
              logger: { info: () => {}, warn: () => {} },
            });
            if (!installed.ok) {
              throw new Error(installed.error);
            }
            const projectRoot = resolvePluginNpmProjectDir({ npmDir, packageName });
            const protectedFiles = [
              path.join(projectRoot, "package.json"),
              path.join(projectRoot, "package-lock.json"),
              path.join(installed.targetDir, "package.json"),
              path.join(installed.targetDir, "openclaw.plugin.json"),
              path.join(installed.targetDir, "dist", "index.js"),
            ];
            const before = await Promise.all(
              protectedFiles.map((file) => fs.readFile(file, "utf8")),
            );
            const config: OpenClawConfig = {
              plugins: { allow: [packageName], entries: { [packageName]: { enabled: true } } },
            };
            const records: Record<string, PluginInstallRecord> = {
              [packageName]: {
                source: "npm",
                spec: packageName,
                installPath: installed.targetDir,
                version: "1.0.0",
              },
            };
            await state.writeConfig(config);
            await seedInstalledPluginIndex(records, { config, env: process.env });
            const configBefore = await fs.readFile(state.configPath, "utf8");
            let successfulNpmInstalls = 0;
            const realRun = processExecution.runCommandWithTimeout;
            vi.spyOn(processExecution, "runCommandWithTimeout").mockImplementation(
              async (...args) => {
                const result = await realRun(...args);
                const [argv, options] = args;
                if (
                  argv[0] !== "npm" ||
                  argv[1] !== "install" ||
                  argv.includes("--package-lock-only") ||
                  result.code !== 0
                ) {
                  return result;
                }
                expect(typeof options === "object" ? options.timeoutMs : options).toBe(
                  expectedTimeoutMs,
                );
                const attemptRoot = typeof options === "object" ? options.cwd : undefined;
                if (!attemptRoot) {
                  throw new Error("Missing real npm staging directory");
                }
                const pluginRoot = path.join(attemptRoot, "node_modules", packageName);
                const manifest = JSON.parse(
                  await fs.readFile(path.join(pluginRoot, "package.json"), "utf8"),
                );
                expect(manifest.version).toBe("2.0.0");
                successfulNpmInstalls += 1;
                const hoisted = path.join(attemptRoot, "node_modules", dependency);
                expect(
                  JSON.parse(await fs.readFile(path.join(hoisted, "package.json"), "utf8")).name,
                ).toBe(dependency);
                if (payload === "empty-manifest" || payload === "malformed-manifest") {
                  await fs.writeFile(
                    path.join(hoisted, "package.json"),
                    payload === "empty-manifest" ? "" : "{",
                  );
                } else if (payload !== "hoisted") {
                  await fs.rm(hoisted, { recursive: true });
                  if (payload === "empty") {
                    await fs.mkdir(hoisted);
                  }
                  if (payload === "ancestor" || payload === "outside-symlink") {
                    const outside = path.join(npmDir, "node_modules", dependency);
                    await fs.mkdir(outside, { recursive: true });
                    await fs.writeFile(
                      path.join(outside, "package.json"),
                      JSON.stringify({ name: dependency, version: "1.0.0" }),
                    );
                    if (payload === "outside-symlink") {
                      await fs.symlink(outside, hoisted, "junction");
                    }
                  }
                }
                return result;
              },
            );
            const onCapabilityConsent = vi.fn(async (review: { reviewToken: string }) => ({
              reviewToken: review.reviewToken,
            }));
            const result = await withPluginCache(createPluginCache(), async () =>
              updatePluginsAfterCoreUpdate({
                root: state.root,
                channel: "stable",
                ...(await preparePostCorePluginConfig({ requestedChannel: null })),
                pluginInstallRecords: records,
                timeoutMs: 120_000,
                workTimeoutMs,
                json: true,
                onCapabilityConsent,
              }),
            );
            expect(successfulNpmInstalls, JSON.stringify(result)).toBe(1);
            const persisted = readPersistedInstalledPluginIndexInstallRecords();
            if (!persisted) {
              throw new Error("Expected the persisted installed-plugin index");
            }
            if (payload === "hoisted" || payload === "optional") {
              expect(result.status, JSON.stringify(result)).toBe("ok");
              expect(result.npm.outcomes).toContainEqual(
                expect.objectContaining({
                  pluginId: packageName,
                  status: "updated",
                  nextVersion: "2.0.0",
                }),
              );
              expect(persisted[packageName]?.version).toBe("2.0.0");
              expect(
                JSON.parse(
                  await fs.readFile(
                    path.join(persisted[packageName]!.installPath!, "package.json"),
                    "utf8",
                  ),
                ).version,
              ).toBe("2.0.0");
            } else {
              expect(result.status, JSON.stringify(result)).toBe("warning");
              expect(result.npm.outcomes).toContainEqual(
                expect.objectContaining({
                  pluginId: packageName,
                  status: "error",
                  message: expect.stringContaining(
                    payload.endsWith("manifest") ? "package.json" : dependency,
                  ),
                }),
              );
              expect(onCapabilityConsent).not.toHaveBeenCalled();
              expect(persisted).toEqual(records);
              expect(await fs.readFile(state.configPath, "utf8")).toBe(configBefore);
              expect(
                await Promise.all(protectedFiles.map((file) => fs.readFile(file, "utf8"))),
              ).toEqual(before);
            }
          });
        },
      );
    },
  );
});
