import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveEffectivePluginIdsAsync } from "./effective-plugin-ids.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { withPluginGenerationSourceCustody } from "./plugin-generation-source-lookup.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { resolvePluginSetupAutoEnableReasons } from "./setup-registry.js";

it.each([false, true])(
  "prepares cold setup before resolving effective plugin ids (metadata snapshot: %s)",
  async (prepared) => {
    // Thread workers skip the production preparation guard.
    expect(isMainThread, "setup preparation requires the plugins fork lane").toBe(true);
    await withOpenClawTestState(
      { label: "effective-plugin-setup", env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const id = "setup-owner";
        const rootDir = state.path("plugin");
        const source = path.join(rootDir, "setup-api.cjs");
        const artifacts = {
          "package.json": {
            name: "@example/setup-owner",
            version: "1.0.0",
            type: "commonjs",
            openclaw: { extensions: ["./index.cjs"], setupEntry: "./setup-api.cjs" },
          },
          "openclaw.plugin.json": {
            id,
            channels: [id],
            setup: { requiresRuntime: true },
            configSchema: { type: "object", properties: {} },
          },
          "index.cjs": 'throw new Error("effective ids must not load plugin runtime");',
          "setup-api.cjs": `module.exports = { id: "setup-owner", register(api) {
            api.registerAutoEnableProbe(() => "setup fixture configured");
          } };`,
        };
        fs.mkdirSync(rootDir, { recursive: true });
        for (const [name, value] of Object.entries(artifacts)) {
          fs.writeFileSync(
            path.join(rootDir, name),
            typeof value === "string" ? value : JSON.stringify(value),
          );
        }
        const params = {
          config: {
            plugins: {
              enabled: true,
              allow: [id],
              entries: { [id]: { enabled: true, config: {} } },
              load: { paths: [rootDir] },
            },
          },
          env: state.env,
          workspaceDir: state.workspaceDir,
        };
        await using cache = createPluginCache();
        await withPluginCache(cache, () =>
          withPluginGenerationSourceCustody(async () => {
            const snapshot = loadPluginMetadataSnapshot(params);
            expect(snapshot.plugins).toMatchObject([{ id, origin: "config", setupSource: source }]);
            expect(cache.setupModules.size).toBe(0);
            const ids = await resolveEffectivePluginIdsAsync({
              ...params,
              ...(prepared ? { metadataSnapshot: snapshot } : {}),
            });
            expect(ids).toEqual([id]);
            expect(
              resolvePluginSetupAutoEnableReasons({
                ...params,
                pluginIds: [id],
                manifestRegistry: snapshot.manifestRegistry,
              }),
            ).toEqual([{ pluginId: id, reason: "setup fixture configured" }]);
          }),
        );
      },
    );
  },
);
