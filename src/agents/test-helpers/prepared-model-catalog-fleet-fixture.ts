import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadPluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { saveAuthProfileStore } from "../auth-profiles/store-runtime.js";
import {
  EXTERNAL_AUTH_PATH_ENV,
  REF_ONLY_API_ENV,
  REF_ONLY_TOKEN_ENV,
  createCatalogFixture,
  PROVIDER_ID,
} from "../prepared-model-catalog-worker.test-support.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "../prepared-model-runtime.js";

export function createCatalogFleetFixture(makeTempDir: (prefix: string) => string) {
  return async function createFleetFixture(
    onBeforePublication?: (fixture: ReturnType<typeof createCatalogFixture>) => void,
    stableCatalog = false,
    options: { asyncSyntheticAuth?: boolean; agentCount?: number } = {},
  ) {
    const fixture = createCatalogFixture(
      makeTempDir,
      0,
      {},
      { asyncSyntheticAuth: options.asyncSyntheticAuth },
    );
    if (stableCatalog) {
      fs.writeFileSync(
        path.join(fixture.root, "plugin", "openclaw.plugin.json"),
        JSON.stringify({
          id: PROVIDER_ID,
          providers: [PROVIDER_ID],
          configSchema: { type: "object", additionalProperties: false },
        }),
      );
      fs.writeFileSync(
        path.join(fixture.root, "plugin", "index.cjs"),
        `const fs = require("node:fs");
module.exports = { id: ${JSON.stringify(PROVIDER_ID)}, register(api) {
  api.registerProvider({ id: ${JSON.stringify(PROVIDER_ID)}, label: "Retained catalog", auth: [],
    catalog: { async run(ctx) {
      const marker = process.env.OPENCLAW_WORKER_CATALOG_MARKER;
      fs.writeFileSync(marker + ".worker", JSON.stringify({ pid: process.pid, cwd: process.cwd(),
        threadId: require("node:worker_threads").threadId, agentDir: ctx.agentDir }));
      fs.appendFileSync(marker, "start\\n");
      const barrier = marker + ".hold";
      if (fs.existsSync(barrier)) await new Promise(resolve => {
        const check = () => {
          if (!fs.existsSync(barrier)) { fs.unwatchFile(barrier, check); resolve(); }
        };
        fs.watchFile(barrier, { interval: 10 }, check);
        check();
      });
      return { provider: { api: "openai-completions", baseUrl: "https://worker-catalog.invalid/v1",
        models: [{ id: "sqlite-model", name: "Configured model" },
          { id: "plugin-generation-v1", name: "Retained model" }] } };
    } },
  });
} };`,
      );
      saveAuthProfileStore({ version: 1, profiles: {} }, fixture.agentDir);
    }
    for (const name of [
      "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_WORKER_CATALOG_MARKER",
      EXTERNAL_AUTH_PATH_ENV,
      REF_ONLY_API_ENV,
      REF_ONLY_TOKEN_ENV,
    ] as const) {
      vi.stubEnv(name, fixture.env[name]);
    }
    const agentIds = ["fleet-a", "fleet-b", "fleet-c", "fleet-d"].slice(0, options.agentCount ?? 4);
    const entries = Object.fromEntries(
      agentIds.map(
        (id) =>
          [
            id,
            {
              agentDir: path.join(fixture.env.OPENCLAW_STATE_DIR!, "agents", id, "agent"),
              workspace: path.join(fixture.root, `${id}-workspace`),
            },
          ] as const,
      ),
    );
    const config = {
      ...fixture.config,
      agents: {
        ...fixture.config.agents,
        ...(stableCatalog ? { defaults: { ...fixture.config.agents.defaults, models: {} } } : {}),
        entries,
      },
    } satisfies OpenClawConfig;
    for (const id of agentIds) {
      fs.mkdirSync(entries[id]!.workspace, { recursive: true });
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            [`fleet:${id}`]: { type: "api_key", provider: "fleet-proof", key: `synthetic-${id}` },
            ...(stableCatalog
              ? {
                  [`${PROVIDER_ID}:default`]: {
                    type: "api_key" as const,
                    provider: PROVIDER_ID,
                    key: `synthetic-catalog-${id}`,
                  },
                }
              : {}),
          },
        },
        entries[id]!.agentDir,
      );
    }
    onBeforePublication?.(fixture);
    await refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      allowGatewaySubagentBinding: true,
      catalogMode: "static",
      pluginMetadataSnapshot: loadPluginMetadataSnapshot({
        config,
        env: process.env,
        workspaceDir: fixture.workspaceDir,
      }),
    });
    const snapshots = agentIds.map((agentId) =>
      getPreparedModelRuntimeSnapshot({
        agentId,
        agentDir: entries[agentId]!.agentDir,
        config,
      })!,
    );
    return { ...fixture, config, entries, snapshots, agentIds };
  };
}
