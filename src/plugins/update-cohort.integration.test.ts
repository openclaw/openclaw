import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { withEnvAsync } from "../test-utils/env.js";
import { runActivePluginPayloadSmokeCheck } from "./active-payload-verification.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { createInstalledPluginOwnershipResolver } from "./installed-plugin-package-ownership.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { convergePluginReleaseCohort } from "./update-cohort.js";
describe("plugin release cohort real synchronization", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  it("refuses peer-link repair before changing an installed package", async () => {
    const root = fs.realpathSync(tempDirs.make("openclaw-cohort-guard"));
    const stateDir = path.join(root, "state");
    const installPath = path.join(stateDir, "extensions", "cohort");
    fs.mkdirSync(installPath, { recursive: true });
    fs.writeFileSync(
      path.join(installPath, "package.json"),
      JSON.stringify({
        name: "@example/cohort",
        version: "1.0.0",
        openclaw: { extensions: ["./index.js"] },
        peerDependencies: { openclaw: "*" },
      }),
    );
    fs.writeFileSync(path.join(installPath, "index.js"), "export default {};\n");
    fs.writeFileSync(
      path.join(installPath, "openclaw.plugin.json"),
      JSON.stringify({ id: "cohort", configSchema: { type: "object" } }),
    );
    const config: OpenClawConfig = {
      plugins: {
        entries: { cohort: { enabled: true } },
        installs: { cohort: { source: "npm", spec: "@example/cohort", installPath } },
      },
    };
    const originalConfig = structuredClone(config);
    const beforePersistentEffect = vi.fn(async () => {
      expect(fs.existsSync(path.join(installPath, "node_modules"))).toBe(false);
      throw new Error("recovery capture refused");
    });
    await withServer(
      (_request, response) => {
        response.writeHead(404);
        response.end("Fixture package is unavailable");
      },
      async (registry) => {
        const env = {
          HOME: root,
          OPENCLAW_STATE_DIR: stateDir,
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
          NPM_CONFIG_REGISTRY: registry,
          npm_config_registry: registry,
          NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
          NPM_CONFIG_USERCONFIG: path.join(root, "empty.npmrc"),
        };
        await withEnvAsync(env, async () => {
          const operation = withPluginCache(createPluginCache(), () =>
            convergePluginReleaseCohort({
              config,
              channel: "stable",
              timeoutMs: 60_000,
              env,
              preparePersistentEffect: beforePersistentEffect,
            }),
          );
          await expect(operation).rejects.toThrow("recovery capture refused");
          expect(beforePersistentEffect).toHaveBeenCalledOnce();
          expect(fs.existsSync(path.join(installPath, "node_modules"))).toBe(false);
          expect(config).toEqual(originalConfig);
        });
      },
    );
  });

  it("does not request persistent-effect admission for an empty cohort", async () => {
    const root = fs.realpathSync(tempDirs.make("openclaw-cohort-noop"));
    const env = {
      HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
    };
    const beforePersistentEffect = vi.fn(async () => {
      throw new Error("no persistent effect was requested");
    });
    await withEnvAsync(env, async () => {
      const result = await withPluginCache(createPluginCache(), () =>
        convergePluginReleaseCohort({
          config: {},
          channel: "stable",
          timeoutMs: 60_000,
          env,
          preparePersistentEffect: beforePersistentEffect,
        }),
      );
      expect(result.changed).toBe(false);
      expect(beforePersistentEffect).not.toHaveBeenCalled();
      expect(fs.existsSync(env.OPENCLAW_STATE_DIR)).toBe(false);
    });
  });

  it.each([
    { channel: "stable", explicit: true, source: "path" },
    { channel: "dev", explicit: true, source: "path" },
    { channel: "dev", explicit: false, source: "path" },
    { channel: "stable", explicit: true, source: "npm" },
    { channel: "dev", explicit: true, source: "npm" },
    { channel: "stable", explicit: true, source: "none" },
    { channel: "dev", explicit: true, source: "none" },
  ] as const)(
    "preserves package ownership boundaries for $source on $channel (explicit link: $explicit)",
    async ({ channel, explicit, source }) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-cohort-linked-"));
      const bundledRoot = path.join(root, "bundled");
      const bundledPath = path.join(bundledRoot, "llm-task");
      const linkedPath = path.join(root, "linked-task");
      for (const directory of [bundledPath, linkedPath]) {
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
          path.join(directory, "package.json"),
          JSON.stringify({
            name: "@example/llm-task",
            version: "1.0.0",
            openclaw: { extensions: ["./index.js"] },
          }),
        );
        fs.writeFileSync(
          path.join(directory, "openclaw.plugin.json"),
          JSON.stringify({ id: "llm-task", configSchema: { type: "object" } }),
        );
        fs.writeFileSync(path.join(directory, "index.js"), "module.exports = {};\n");
      }
      const record: PluginInstallRecord = {
        source: source === "none" ? "npm" : source,
        spec: "@example/llm-task",
        sourcePath: linkedPath,
        // Retained package metadata disagrees with the explicitly selected source.
        installPath:
          source === "npm" && channel === "dev"
            ? path.join(root, "missing-shadowed-package")
            : bundledPath,
      };
      const config: OpenClawConfig = {
        plugins: {
          installs: source === "none" ? {} : { "llm-task": record },
          load: { paths: explicit ? [linkedPath] : [] },
          entries: { "llm-task": { enabled: true } },
        },
      };
      const env = {
        HOME: root,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
      };
      await withEnvAsync(env, async () => {
        const converge = () =>
          withPluginCache(createPluginCache(), () =>
            convergePluginReleaseCohort({
              config,
              channel,
              coreVersion: "2026.9.4",
              timeoutMs: 60_000,
              env,
            }),
          );
        const result = await converge();
        expect(result.sync.summary.errors).toEqual([]);
        expect(result.remainingMissingPayloads).toEqual([]);
        expect(result.config.plugins?.installs?.["llm-task"]).toEqual(
          source === "none"
            ? undefined
            : explicit
              ? record
              : {
                  ...record,
                  sourcePath: bundledPath,
                  version: undefined,
                  installedAt: expect.any(String),
                },
        );
        expect(result.config.plugins?.load?.paths).toEqual([explicit ? linkedPath : bundledPath]);
        expect(result.sync.summary.switchedToBundled).toEqual(explicit ? [] : ["llm-task"]);
        expect(result.sync.summary.warnings).toEqual([]);
        if (explicit) {
          expect(result.changed).toBe(false);
          expect(result.updateOutcomes).toEqual([
            expect.objectContaining({
              pluginId: "llm-task",
              status: "skipped",
              code: "plugin-operator-managed",
              rootDir: linkedPath,
              source: path.join(linkedPath, "index.js"),
              ...(source === "none" ? {} : { shadowedInstallRecord: record }),
            }),
          ]);
          expect(result.updateOutcomes[0]?.message).toContain(
            "This copy was not updated; verify it against 2026.9.4 or remove it from plugins.load.paths",
          );
          if (source !== "none") {
            expect(result.updateOutcomes[0]?.message).toContain(
              `It shadows the ${source} install @example/llm-task at ${record.installPath}`,
            );
          }
          expect(result.repairOutcomes).toEqual([]);
          expect(
            await runActivePluginPayloadSmokeCheck({
              cfg: result.config,
              records: result.config.plugins?.installs ?? {},
              env,
            }),
          ).toEqual({ checked: [], failures: [] });
        }
        const selectedIndex = withPluginCache(createPluginCache(), () =>
          loadInstalledPluginIndex({
            config: result.config,
            installRecords: result.config.plugins?.installs ?? {},
            env,
          }),
        );
        const selected = selectedIndex.plugins.find((plugin) => plugin.pluginId === "llm-task");
        expect(selected?.rootDir).toBe(explicit ? linkedPath : bundledPath);
        if (explicit) {
          const ownership = createInstalledPluginOwnershipResolver(selectedIndex, env);
          expect(ownership.resolvePackage("llm-task").ok).toBe(false);
          expect(ownership.resolveLifecycle("llm-task").ok).toBe(false);
        }
        expect(fs.readFileSync(path.join(linkedPath, "index.js"), "utf8")).toBe(
          "module.exports = {};\n",
        );
      });
    },
  );
  it("retains local package children and their shadowed npm owner without registry work", async () => {
    const root = fs.realpathSync(tempDirs.make("openclaw-cohort-local-children-"));
    const managedPath = path.join(root, "managed-pack");
    const localPath = path.join(root, "local-pack");
    for (const directory of [managedPath, localPath]) {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({
          name: "@example/pack",
          version: "1.0.0",
          openclaw: { extensions: ["./one.js", "./two.js"] },
        }),
      );
      fs.writeFileSync(
        path.join(directory, "openclaw.plugin.json"),
        JSON.stringify({ id: "pack", configSchema: { type: "object" } }),
      );
      for (const entry of ["one", "two"]) {
        fs.writeFileSync(path.join(directory, `${entry}.js`), "module.exports = {};\n");
      }
    }
    const records = {
      pack: { source: "npm", spec: "@example/pack", installPath: managedPath },
    } satisfies Record<string, PluginInstallRecord>;
    const config = {
      plugins: { load: { paths: [localPath] }, installs: records },
    } satisfies OpenClawConfig;
    let requests = 0;
    await withServer(
      (_request, response) => {
        requests += 1;
        response.writeHead(404);
        response.end("No package replacement is available");
      },
      async (registry) => {
        const env = {
          HOME: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(root, "bundled"),
          NPM_CONFIG_REGISTRY: registry,
          npm_config_registry: registry,
          NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
          NPM_CONFIG_USERCONFIG: path.join(root, "empty.npmrc"),
        };
        await withEnvAsync(env, async () => {
          const result = await withPluginCache(createPluginCache(), () =>
            convergePluginReleaseCohort({ config, channel: "stable", timeoutMs: 10_000, env }),
          );
          expect(requests).toBe(0);
          expect(result.config).toEqual(config);
          expect(result.updateOutcomes).toEqual(
            ["pack/one", "pack/two"].map((pluginId) =>
              expect.objectContaining({
                pluginId,
                code: "plugin-operator-managed",
                shadowedInstallOwner: "pack",
                shadowedInstallRecord: records.pack,
              }),
            ),
          );
          expect(await runActivePluginPayloadSmokeCheck({ cfg: config, records, env })).toEqual({
            checked: [],
            failures: [],
          });
          for (const directory of [managedPath, localPath]) {
            for (const entry of ["one", "two"]) {
              expect(fs.readFileSync(path.join(directory, `${entry}.js`), "utf8")).toBe(
                "module.exports = {};\n",
              );
            }
          }
        });
      },
    );
  });
  it.each(["none", "missing", "installed"] as const)(
    "keeps current payloads after a dev switch when a failing npm sibling is %s",
    async (sibling) => {
      const hasSibling = sibling !== "none";
      const root = fs.realpathSync(tempDirs.make("openclaw-cohort-dev"));
      const bundledRoot = path.join(root, "bundled");
      const bundledPath = path.join(bundledRoot, "cohort");
      const oldPath = path.join(root, "removed-npm-package");
      const siblingPath = path.join(root, "sibling-package");
      fs.mkdirSync(bundledPath, { recursive: true });
      fs.writeFileSync(
        path.join(bundledPath, "package.json"),
        JSON.stringify({
          name: "@example/cohort",
          version: "1.0.0",
          openclaw: { extensions: ["./index.js"] },
        }),
      );
      fs.writeFileSync(
        path.join(bundledPath, "openclaw.plugin.json"),
        JSON.stringify({
          id: "cohort",
          configSchema: { type: "object" },
        }),
      );
      fs.writeFileSync(path.join(bundledPath, "index.js"), "module.exports = {};\n");
      if (sibling === "installed") {
        fs.mkdirSync(siblingPath);
        fs.writeFileSync(
          path.join(siblingPath, "package.json"),
          JSON.stringify({
            name: "@example/broken",
            version: "1.0.0",
            openclaw: { extensions: ["./index.js"] },
          }),
        );
        fs.writeFileSync(
          path.join(siblingPath, "openclaw.plugin.json"),
          JSON.stringify({ id: "broken", configSchema: { type: "object" } }),
        );
        fs.writeFileSync(
          path.join(siblingPath, "index.js"),
          "module.exports = { previous: true };\n",
        );
      }
      const records: Record<string, PluginInstallRecord> = {
        ...(hasSibling
          ? {
              broken: {
                source: "npm" as const,
                spec: "@example/broken",
                installPath: siblingPath,
                ...(sibling === "installed" ? { version: "1.0.0" } : {}),
              },
            }
          : {}),
        cohort: { source: "npm", spec: "@example/cohort", installPath: oldPath },
      };
      const config: OpenClawConfig = {
        plugins: {
          installs: records,
          entries: {
            cohort: { enabled: true },
            ...(hasSibling ? { broken: { enabled: true } } : {}),
          },
        },
      };
      let registryRequests = 0;
      await withServer(
        (_request, response) => {
          registryRequests += 1;
          response.writeHead(404);
          response.end("Fixture package is unavailable");
        },
        async (registry) => {
          const env = {
            HOME: root,
            OPENCLAW_STATE_DIR: path.join(root, "state"),
            OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
            NPM_CONFIG_REGISTRY: registry,
            npm_config_registry: registry,
            NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
            NPM_CONFIG_USERCONFIG: path.join(root, "empty.npmrc"),
          };
          await withEnvAsync(env, async () => {
            const result = await withPluginCache(createPluginCache(), () =>
              convergePluginReleaseCohort({
                config,
                channel: "dev",
                timeoutMs: 60_000,
                env,
              }),
            );
            expect(result.sync.summary.switchedToBundled).toEqual(["cohort"]);
            expect(result.config.plugins?.installs?.cohort).toMatchObject({
              source: "path",
              installPath: bundledPath,
            });
            expect(result.remainingMissingPayloads.map((entry) => entry.pluginId)).toEqual(
              sibling === "missing" ? ["broken"] : [],
            );
            expect(result.missingPayloads.map((entry) => entry.pluginId)).toEqual(
              sibling === "missing" ? ["broken"] : [],
            );
            if (hasSibling) {
              expect(registryRequests).toBeGreaterThan(0);
              expect(
                [...result.repairOutcomes, ...result.updateOutcomes].filter(
                  (outcome) => outcome.pluginId === "broken",
                ),
              ).toEqual([
                expect.objectContaining({
                  pluginId: "broken",
                  status: sibling === "installed" ? "unchanged" : "error",
                  ...(sibling === "installed"
                    ? { code: "plugin-target-unavailable", currentVersion: "1.0.0" }
                    : {}),
                }),
              ]);
              expect(result.config.plugins?.entries?.broken?.enabled).toBe(true);
              expect(result.config.plugins?.installs?.broken).toEqual(records.broken);
              if (sibling === "installed") {
                expect(fs.readFileSync(path.join(siblingPath, "index.js"), "utf8")).toBe(
                  "module.exports = { previous: true };\n",
                );
              }
            } else {
              expect(registryRequests).toBe(0);
              expect(result.repairOutcomes).toEqual([]);
            }
          });
        },
      );
    },
  );
});
