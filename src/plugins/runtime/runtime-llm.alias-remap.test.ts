// A plugin LLM completion must authorize the model it actually dispatches, even when a
// plugin operation remaps the requested alias while the request is being admitted.
import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../agents/auth-profiles/runtime-snapshots.js";
import {
  markPreparedModelRuntimeSnapshotsStale,
  refreshPreparedModelRuntimeSnapshots,
} from "../../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../agents/prepared-model-runtime.test-support.js";
import {
  acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel,
} from "../../agents/simple-completion-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { setGatewayPluginMetadataSnapshot } from "../current-plugin-metadata-snapshot.js";
import { resetPluginLoaderTestStateForTest } from "../loader.test-fixtures.js";
import { createPluginCache, retirePluginCache, withPluginCache } from "../plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "../plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import { setActivePluginRegistry } from "../runtime.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../test-helpers/cold-plugin-fixtures.js";
import { createSyncSuiteTempRootTracker } from "../test-helpers/fs-fixtures.js";
import { withPluginRuntimeGenerationScope } from "./generation-scope.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";

const PROOF_ALIAS = "proof-alias";
// Match the transport name to exercise runtime normalization, not the
// custom-endpoint parser that intentionally skips runtime aliases.
const PROVIDER_ID = "openai-completions";
const ALLOWED_MODEL = "allowed-model";
const BLOCKED_MODEL = "blocked-model";
const CURRENT_MODEL = "current-model";

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

it.each([
  "allowed-to-blocked",
  "blocked-to-allowed",
  "retained-normalizer",
  "committed-normalizer",
  "replacement-pending",
] as const)("uses the admitted completion target: %s", async (scenario) => {
  const roots = createSyncSuiteTempRootTracker("runtime-llm-alias-remap");
  const root = fs.realpathSync(roots.makeTempDir());
  const workspaceDir = path.join(root, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const denies = scenario === "allowed-to-blocked";
  const retained = writeAliasFixture(path.join(root, "retained"), "alias-retained", {
    [PROOF_ALIAS]: denies ? ALLOWED_MODEL : BLOCKED_MODEL,
    ...(denies ? { [BLOCKED_MODEL]: ALLOWED_MODEL } : {}),
  });
  const successor = writeAliasFixture(path.join(root, "successor"), "alias-successor", {
    [PROOF_ALIAS]: denies ? BLOCKED_MODEL : ALLOWED_MODEL,
    // Reapplying aliases to a selected target must not authorize another model.
    ...(denies ? { [BLOCKED_MODEL]: ALLOWED_MODEL } : {}),
  });
  await using resources = new AsyncDisposableStack();
  const portClaim = await acquireTestPortBlock({ offsets: [0] });
  resources.defer(portClaim.release);
  const requests: string[] = [];
  const server = createServer((request, response: ServerResponse) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push((JSON.parse(body) as { model: string }).model);
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
  });
  await new Promise<void>((resolve) => {
    server.listen(portClaim.port, "127.0.0.1", resolve);
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
          models: [ALLOWED_MODEL, BLOCKED_MODEL, CURRENT_MODEL].map((id) => ({
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
          const replacing = scenario === "replacement-pending";
          if (replacing) {
            setGatewayPluginMetadataSnapshot(retainedMetadata, {
              config: retainedConfig,
              workspaceDir,
            });
            await refreshPreparedModelRuntimeSnapshots(retainedConfig, {
              gatewayLifecycle: true,
              catalogMode: "static",
            });
            markPreparedModelRuntimeSnapshotsStale("completion fixture replacement", {
              waitForReplacement: true,
            });
          }
          const pending = replacing
            ? withPluginRuntimeGenerationScope({ metadataSnapshot: retainedMetadata }, () =>
                acquireSimpleCompletionModelForAgent({
                  cfg: retainedConfig,
                  agentId: "main",
                  modelRef: PROOF_ALIAS,
                }),
              )
            : undefined;
          // Observe a rejected acquisition even when replacement publication has not settled yet.
          void pending?.catch(() => {});
          setGatewayPluginMetadataSnapshot(successorMetadata, {
            config: successorConfig,
            workspaceDir,
          });
          retirement = retirePluginCache(retainedCache);
          if (replacing) {
            await refreshPreparedModelRuntimeSnapshots(successorConfig, {
              gatewayLifecycle: true,
              catalogMode: "static",
            });
          }

          const llm = createRuntimeLlm({
            getConfig: () => successorConfig,
            authority: {
              caller: { kind: "plugin", id: successor.pluginId },
              allowComplete: true,
              allowModelOverride: true,
              allowedCompletionModels: [`${PROVIDER_ID}/${ALLOWED_MODEL}`],
            },
          });
          const retainedRegistry = createEmptyPluginRegistry();
          retainedRegistry.providers.push({
            pluginId: retained.pluginId,
            source: retained.runtimeSource,
            provider: {
              id: PROVIDER_ID,
              label: "Retained normalizer",
              auth: [],
              normalizeModelId: ({ modelId }) =>
                modelId === ALLOWED_MODEL ? BLOCKED_MODEL : modelId,
            },
          });
          if (scenario === "committed-normalizer") {
            const currentRegistry = createEmptyPluginRegistry();
            currentRegistry.providers.push({
              pluginId: successor.pluginId,
              source: successor.runtimeSource,
              provider: {
                id: PROVIDER_ID,
                label: "Committed normalizer",
                auth: [],
                normalizeModelId: ({ modelId }) =>
                  modelId === ALLOWED_MODEL ? CURRENT_MODEL : modelId,
              },
            });
            setActivePluginRegistry(currentRegistry);
          }
          const complete = (model?: string) =>
            withPluginRuntimeGenerationScope({ metadataSnapshot: retainedMetadata }, () =>
              llm.complete({ model, messages: [{ role: "user", content: "Complete" }] }),
            );

          if (
            scenario === "retained-normalizer" ||
            scenario === "committed-normalizer" ||
            replacing
          ) {
            // Fresh acquisition cannot mix successor manifests with retained hooks.
            const result = await withPluginRuntimeGenerationScope(
              { metadataSnapshot: retainedMetadata, pluginRegistry: retainedRegistry },
              async () => {
                const acquired = await (pending ??
                  acquireSimpleCompletionModelForAgent({
                    cfg: successorConfig,
                    agentId: "main",
                    modelRef: PROOF_ALIAS,
                  }));
                if ("error" in acquired) {
                  throw new Error(acquired.error);
                }
                await using prepared = acquired;
                await completeWithPreparedSimpleCompletionModel({
                  model: prepared.model,
                  auth: prepared.auth,
                  cfg: successorConfig,
                  context: { messages: [{ role: "user", content: "Complete", timestamp: 1 }] },
                });
                return prepared.selection;
              },
            );
            const expectedModel =
              scenario === "committed-normalizer" ? CURRENT_MODEL : ALLOWED_MODEL;
            expect(result).toMatchObject({ provider: PROVIDER_ID, modelId: expectedModel });
            expect(requests).toEqual([expectedModel]);
          } else {
            await expect(complete(PROVIDER_ID + "/" + ALLOWED_MODEL)).resolves.toMatchObject({
              text: "aliased",
              provider: PROVIDER_ID,
              model: ALLOWED_MODEL,
            });
            if (denies) {
              await expect(complete(PROOF_ALIAS)).rejects.toMatchObject({
                code: "LLM_COMPLETION_NOT_AUTHORIZED",
                message: expect.stringContaining(PROVIDER_ID + "/" + BLOCKED_MODEL),
              });
              expect(requests).toEqual([ALLOWED_MODEL]);
            } else {
              // Explicit aliases and configured defaults both use the successor's target.
              for (const model of [PROOF_ALIAS, undefined]) {
                await expect(complete(model)).resolves.toMatchObject({
                  text: "aliased",
                  provider: PROVIDER_ID,
                  model: ALLOWED_MODEL,
                });
              }
              expect(requests).toEqual([ALLOWED_MODEL, ALLOWED_MODEL, ALLOWED_MODEL]);
            }
          }
        } finally {
          await resetPreparedModelRuntimeSnapshotsForTest();
          await retirement?.catch(() => {});
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
