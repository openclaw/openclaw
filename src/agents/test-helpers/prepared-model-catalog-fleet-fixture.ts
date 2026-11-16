import fs from "node:fs";
import path from "node:path";
import { fixtureReceiptWorkerClientSource } from "../../../test/helpers/fixture-receipts.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadPluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { saveAuthProfileStore } from "../auth-profiles/store-runtime.js";
import { apiKey, authStore } from "../model-catalog-fixtures.test-support.js";
import { stubCatalogEnv } from "../prepared-model-catalog-worker.shared.test-support.js";
import {
  createCatalogFixture,
  PROVIDER_ID,
  writeFixtureFiles,
} from "../prepared-model-catalog-worker.test-support.js";
import {
  getPreparedModelRuntimeSnapshot,
  publishPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "../prepared-model-runtime.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.types.js";

export function createCatalogFleetFixture(
  makeTempDir: (prefix: string) => string,
  receiptBroadcastName?: () => string,
) {
  return async function createFleetFixture(
    onBeforePublication?: (fixture: Awaited<ReturnType<typeof createCatalogFixture>>) => void,
    stableCatalog = false,
    options: {
      asyncSyntheticAuth?: boolean;
      agentCount?: number;
      publication?: "individual";
    } = {},
  ) {
    const broadcastName = receiptBroadcastName?.();
    const fixture = await createCatalogFixture(
      makeTempDir,
      0,
      {},
      { asyncSyntheticAuth: options.asyncSyntheticAuth, receiptBroadcastName: broadcastName },
    );
    const { root, agentDir, workspaceDir, env } = fixture;
    const individual = options.publication === "individual";
    if (stableCatalog) {
      writeFixtureFiles(path.join(root, "plugin"), {
        "openclaw.plugin.json": {
          id: PROVIDER_ID,
          providers: [PROVIDER_ID],
          configSchema: { type: "object", additionalProperties: false },
        },
        "index.cjs": `const fs = require("node:fs");
module.exports = { id: ${JSON.stringify(PROVIDER_ID)}, register(api) {
  api.registerProvider({ id: ${JSON.stringify(PROVIDER_ID)}, label: "Retained catalog", auth: [],
    catalog: { async run(ctx) {
      ${broadcastName ? `const { sendReceipt } = await import(${JSON.stringify("data:text/javascript," + encodeURIComponent(fixtureReceiptWorkerClientSource(broadcastName) + "\nexport { sendReceipt };"))});` : ""}
      const marker = process.env.OPENCLAW_WORKER_CATALOG_MARKER;
      fs.writeFileSync(marker + ".worker", JSON.stringify({ pid: process.pid, cwd: process.cwd(),
        threadId: require("node:worker_threads").threadId, agentDir: ctx.agentDir }));
      fs.appendFileSync(marker, "start\\n");
      ${broadcastName ? 'sendReceipt(marker, "start");' : ""}
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
      });
      saveAuthProfileStore(authStore(), agentDir);
    }
    stubCatalogEnv(env);
    const agentIds = ["fleet-a", "fleet-b", "fleet-c", "fleet-d"].slice(0, options.agentCount ?? 4);
    const entries: Record<string, { agentDir: string; workspace: string }> = {};
    for (const id of agentIds) {
      const entry = (entries[id] = {
        agentDir: path.join(env.OPENCLAW_STATE_DIR!, "agents", id, "agent"),
        workspace: individual ? workspaceDir : path.join(root, `${id}-workspace`),
      });
      fs.mkdirSync(entry.workspace, { recursive: true });
      const profiles = { [`fleet:${id}`]: apiKey("fleet-proof", `synthetic-${id}`) };
      if (stableCatalog) {
        profiles[`${PROVIDER_ID}:default`] = apiKey(PROVIDER_ID, `synthetic-catalog-${id}`);
      }
      saveAuthProfileStore(authStore(profiles), entry.agentDir);
    }
    const config = {
      ...fixture.config,
      agents: {
        ...fixture.config.agents,
        ...(stableCatalog ? { defaults: { ...fixture.config.agents.defaults, models: {} } } : {}),
        entries,
      },
    } satisfies OpenClawConfig;
    onBeforePublication?.(fixture);
    const snapshots: PreparedModelRuntimeSnapshot[] = [];
    // Cold scoped tests publish individually; fleet refresh renews all credentialed providers.
    if (!individual) {
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        allowGatewaySubagentBinding: true,
        catalogMode: "static",
        pluginMetadataSnapshot: loadPluginMetadataSnapshot({
          config,
          env: process.env,
          workspaceDir,
        }),
      });
    }
    for (const agentId of agentIds) {
      const input = { agentId, agentDir: entries[agentId]!.agentDir, config };
      snapshots.push(
        individual
          ? await publishPreparedModelRuntimeSnapshot(
              {
                ...input,
                workspaceDir: entries[agentId]!.workspace,
                allowGatewaySubagentBinding: true,
              },
              { provenance: "configured", catalogMode: "static" },
            )
          : getPreparedModelRuntimeSnapshot(input)!,
      );
    }
    return { ...fixture, config, entries, snapshots, agentIds };
  };
}
