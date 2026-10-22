import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveAgentDir } from "../../agents/agent-scope-config.js";
import { configFor } from "../../agents/model-auth.fixtures.test-support.js";
import {
  acquireAgentRunPreparedModelRuntime,
  refreshPreparedModelRuntimeSnapshots,
} from "../../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../agents/prepared-model-runtime.test-support.js";
import {
  completionChunk,
  completionModelDefinition,
  startCompletionServer,
} from "../../agents/simple-completion.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ContextEngineFactoryResources } from "../../context-engine/registry.resources.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { setGatewayPluginMetadataSnapshot } from "../current-plugin-metadata-snapshot.js";
import { resetPluginLoaderTestStateForTest } from "../loader.test-fixtures.js";
import * as caches from "../plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "../plugin-metadata-snapshot.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../test-helpers/cold-plugin-fixtures.js";
import { createSyncSuiteTempRootTracker } from "../test-helpers/fs-fixtures.js";
import { withPluginRuntimeGenerationScope } from "./generation-scope.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";

it("admits new completions from a retained engine context after another plugin reloads", async () => {
  const roots = createSyncSuiteTempRootTracker("runtime-llm-retained-generation");
  const root = fs.realpathSync(roots.makeTempDir());
  const fixture = createColdPluginFixture({ rootDir: roots.makeTempDir() });
  fs.writeFileSync(
    fixture.runtimeSource,
    `module.exports = { id: ${JSON.stringify(fixture.pluginId)}, register(api) {
      api.registerProvider({ id: ${JSON.stringify(fixture.providerId)}, label: "Retained", auth: [] });
    } };`,
  );
  const model = completionModelDefinition();
  let requests = 0;
  try {
    await using server = await startCompletionServer((request, response) => {
      request.resume();
      requests++;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(completionChunk("summary", model.id));
    });
    const config: OpenClawConfig = {
      agents: { defaults: { workspace: root, model: `${fixture.providerId}/${model.id}` } },
      ...configFor(fixture.providerId, server.baseUrl, {
        api: "openai-completions",
        apiKey: "fixture-key",
        models: [model],
      }),
      plugins: {
        ...createColdPluginConfig(fixture.rootDir, fixture.pluginId).plugins,
        slots: { memory: "none" },
      },
    };
    const env = {
      ...createColdPluginHermeticEnv(root, { bundledPluginsDir: roots.makeTempDir() }),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: path.join(root, "state"),
    };
    await withEnvAsync(env, async () => {
      const publication = { gatewayLifecycle: true, catalogMode: "static" as const };
      const publish = async (cfg: OpenClawConfig) => {
        const cache = caches.createPluginCache();
        const scope = { config: cfg, workspaceDir: root };
        const metadata = caches.withPluginCache(cache, () => resolvePluginMetadataSnapshot(scope));
        setGatewayPluginMetadataSnapshot(metadata, scope);
        await refreshPreparedModelRuntimeSnapshots(cfg, publication);
        return cache;
      };
      try {
        const previousCache = await publish(config);
        const turn = await acquireAgentRunPreparedModelRuntime({
          config,
          agentId: "main",
          agentDir: resolveAgentDir(config, "main"),
          workspaceDir: root,
        });
        const engine = withPluginRuntimeGenerationScope(
          turn.snapshot,
          () => new ContextEngineFactoryResources([]),
        );
        await turn[Symbol.asyncDispose]();
        const replacement = { ...config, messages: { responsePrefix: "replacement" } };
        await publish(replacement);
        const retirement = caches.retirePluginCache(previousCache);
        expect(() => caches.retainPluginCache(previousCache)).toThrow(
          "Plugin inventory has retired",
        );
        const llm = createRuntimeLlm({ getConfig: () => replacement });
        const result = await engine.run(() =>
          llm.complete({ messages: [{ role: "user", content: "summarize" }] }),
        );
        expect({ text: result.text, requests }).toEqual({ text: "summary", requests: 1 });
        await engine.release();
        await retirement;
      } finally {
        await resetPreparedModelRuntimeSnapshotsForTest();
        clearPluginMetadataLifecycleCaches();
        resetPluginLoaderTestStateForTest();
      }
    });
  } finally {
    roots.cleanup();
  }
});
