import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { withEnvAsync } from "../test-utils/env.js";
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
              beforePersistentEffect,
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
          beforePersistentEffect,
        }),
      );
      expect(result.changed).toBe(false);
      expect(beforePersistentEffect).not.toHaveBeenCalled();
      expect(fs.existsSync(env.OPENCLAW_STATE_DIR)).toBe(false);
    });
  });

  it.each([false, true])(
    "checks current payloads after a dev switch (missing npm sibling: %s)",
    async (missingSibling) => {
      const root = fs.realpathSync(tempDirs.make("openclaw-cohort-dev"));
      const bundledRoot = path.join(root, "bundled");
      const bundledPath = path.join(bundledRoot, "cohort");
      const oldPath = path.join(root, "removed-npm-package");
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
      const records: Record<string, PluginInstallRecord> = {
        ...(missingSibling
          ? {
              broken: {
                source: "npm" as const,
                spec: "@example/broken",
                installPath: path.join(root, "missing-package"),
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
            ...(missingSibling ? { broken: { enabled: true } } : {}),
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
            expect(result.remainingMissingPayloads).toEqual([]);
            expect(result.missingPayloads.map((entry) => entry.pluginId)).toEqual(
              missingSibling ? ["broken"] : [],
            );
            if (missingSibling) {
              expect(registryRequests).toBeGreaterThan(0);
              expect(result.repairOutcomes).toEqual([
                expect.objectContaining({
                  pluginId: "broken",
                  status: "skipped",
                  message: expect.stringContaining("after plugin update failure"),
                }),
              ]);
              expect(result.config.plugins?.entries?.broken?.enabled).toBe(false);
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
