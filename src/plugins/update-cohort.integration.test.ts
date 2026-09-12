import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { withServer } from "../plugin-sdk/test-helpers/http-test-server.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";
import { convergePluginReleaseCohort } from "./update-cohort.js";

describe("plugin release cohort real synchronization", () => {
  const tempDirs: string[] = [];
  afterEach(() => cleanupTrackedTempDirs(tempDirs));
  it.each(["none", "missing", "installed"] as const)(
    "keeps current payloads after a dev switch when a failing npm sibling is %s",
    async (sibling) => {
      const hasSibling = sibling !== "none";
      const root = fs.realpathSync(makeTrackedTempDir("openclaw-cohort-dev", tempDirs));
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
