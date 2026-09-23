// A plugin LLM completion must authorize the model it actually dispatches, even when a
// plugin operation remaps the requested alias while the request is being admitted.
import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../agents/auth-profiles/runtime-snapshots.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../agents/prepared-model-runtime.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { setGatewayPluginMetadataSnapshot } from "../current-plugin-metadata-snapshot.js";
import { resetPluginLoaderTestStateForTest } from "../loader.test-fixtures.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "../plugin-metadata-snapshot.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../test-helpers/cold-plugin-fixtures.js";
import { createSyncSuiteTempRootTracker } from "../test-helpers/fs-fixtures.js";
import { withPluginRuntimeGenerationScope } from "./generation-scope.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";

const PROOF_ALIAS = "proof-alias";
const PROVIDER_ID = "alias-remap-provider";
const ALLOWED_MODEL = "allowed-model";
const BLOCKED_MODEL = "blocked-model";

function writeAliasFixture(rootDir: string, pluginId: string, aliases: Record<string, string>) {
  fs.mkdirSync(rootDir);
  const fixture = createColdPluginFixture({ rootDir, pluginId, providerId: PROVIDER_ID });
  fs.writeFileSync(
    fixture.runtimeSource,
    `module.exports = { id: ${JSON.stringify(pluginId)}, register(api) { api.registerProvider({ id: ${JSON.stringify(PROVIDER_ID)}, label: "Alias fixture", auth: [] }); } };`,
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: pluginId,
        name: "Alias fixture",
        configSchema: { type: "object" },
        providers: [PROVIDER_ID],
        modelIdNormalization: { providers: { [PROVIDER_ID]: { aliases } } },
      },
      null,
      2,
    ),
    "utf8",
  );
  return fixture;
}

it("rejects a completion whose alias the committed inventory remapped", async () => {
  const roots = createSyncSuiteTempRootTracker("runtime-llm-alias-remap");
  const root = fs.realpathSync(roots.makeTempDir());
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  // The retired inventory also aliases the successor's canonical forbidden model, and the
  // successor chains that forbidden model back to the allowlisted one, so any authorization
  // that re-applies inventory aliases to the selected id would approve a different model than
  // the one the provider request uses.
  const retained = writeAliasFixture(path.join(root, "retained"), "alias-retained", {
    [PROOF_ALIAS]: ALLOWED_MODEL,
    [BLOCKED_MODEL]: ALLOWED_MODEL,
  });
  const successor = writeAliasFixture(path.join(root, "successor"), "alias-successor", {
    [PROOF_ALIAS]: BLOCKED_MODEL,
    [BLOCKED_MODEL]: ALLOWED_MODEL,
  });
  const requests: string[] = [];
  const server = createServer((request, response: ServerResponse) => {
    request.resume();
    requests.push(request.url ?? "/");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({
        id: "alias-remap-response",
        object: "chat.completion.chunk",
        model: "fixture",
        choices: [{ index: 0, delta: { content: "aliased" }, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Alias fixture has no TCP port");
  }
  const configFor = (fixture: typeof retained): OpenClawConfig => ({
    agents: { defaults: { workspace: workspaceDir, model: `${PROVIDER_ID}/${PROOF_ALIAS}` } },
    models: {
      providers: {
        [PROVIDER_ID]: {
          api: "openai-completions",
          apiKey: "fixture-only",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          models: [ALLOWED_MODEL, BLOCKED_MODEL].map((id) => ({
            id,
            name: id,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 1024,
          })),
        },
      },
    },
    plugins: {
      load: { paths: [fixture.rootDir] },
      slots: { memory: "none" },
      entries: { [fixture.pluginId]: { enabled: true } },
    },
  });
  const retainedConfig = configFor(retained);
  const successorConfig = configFor(successor);
  try {
    await withEnvAsync(
      {
        ...createColdPluginHermeticEnv(root, { bundledPluginsDir: roots.makeTempDir() }),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: path.join(root, "state"),
      },
      async () => {
        let retirement: ReturnType<typeof retirePluginCache> | undefined;
        try {
          const retainedCache = createPluginCache();
          const retainedMetadata = withPluginCache(retainedCache, () =>
            resolvePluginMetadataSnapshot({ config: retainedConfig, workspaceDir }),
          );
          const successorCache = createPluginCache();
          const successorMetadata = withPluginCache(successorCache, () =>
            resolvePluginMetadataSnapshot({ config: successorConfig, workspaceDir }),
          );
          setGatewayPluginMetadataSnapshot(successorMetadata, {
            config: successorConfig,
            workspaceDir,
          });
          retirement = retirePluginCache(retainedCache);

          const llm = createRuntimeLlm({
            getConfig: () => successorConfig,
            authority: {
              caller: { kind: "plugin", id: successor.pluginId },
              allowComplete: true,
              allowModelOverride: true,
              allowedCompletionModels: [`${PROVIDER_ID}/${ALLOWED_MODEL}`],
            },
          });
          const complete = (model: string) =>
            withPluginRuntimeGenerationScope({ metadataSnapshot: retainedMetadata }, () =>
              llm.complete({
                model,
                messages: [{ role: "user", content: "Complete" }],
              }),
            );

          // Control: the allowlisted target still completes and reaches the provider.
          await expect(complete(`${PROVIDER_ID}/${ALLOWED_MODEL}`)).resolves.toMatchObject({
            text: "aliased",
            provider: PROVIDER_ID,
            model: ALLOWED_MODEL,
          });
          const controlRequests = requests.length;
          expect(controlRequests).toBeGreaterThan(0);

          // The retained generation authorizes "proof-alias" as the allowed model; the
          // committed inventory remaps it, so the admitted target must be re-authorized.
          await expect(complete(PROOF_ALIAS)).rejects.toMatchObject({
            code: "LLM_COMPLETION_NOT_AUTHORIZED",
          });
          await expect(complete(PROOF_ALIAS)).rejects.toThrow(`${PROVIDER_ID}/${BLOCKED_MODEL}`);
          expect(requests.length).toBe(controlRequests);
        } finally {
          await retirement?.catch(() => {});
          await resetPreparedModelRuntimeSnapshotsForTest();
          clearRuntimeAuthProfileStoreSnapshots();
          clearPluginMetadataLifecycleCaches();
          resetPluginLoaderTestStateForTest();
        }
      },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    roots.cleanup();
  }
});
