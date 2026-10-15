import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveAgentDir } from "../../agents/agent-scope-config.js";
import {
  acquireAgentRunPreparedModelRuntime,
  refreshPreparedModelRuntimeSnapshots,
} from "../../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../agents/prepared-model-runtime.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ContextEngineFactoryResources } from "../../context-engine/registry.resources.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { setGatewayPluginMetadataSnapshot } from "../current-plugin-metadata-snapshot.js";
import { resetPluginLoaderTestStateForTest } from "../loader.test-fixtures.js";
import {
  createPluginCache,
  retainPluginCache,
  retirePluginCache,
  withPluginCache,
} from "../plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugin-metadata-lifecycle.js";
import { resolvePluginMetadataSnapshot } from "../plugin-metadata-snapshot.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
} from "../test-helpers/cold-plugin-fixtures.js";
import { createSyncSuiteTempRootTracker } from "../test-helpers/fs-fixtures.js";
import { withPluginRuntimeGenerationScope } from "./generation-scope.js";
import { createRuntimeLlm } from "./runtime-llm.runtime.js";

it("admits new completions from a retained engine context after another plugin reloads", async () => {
  const roots = createSyncSuiteTempRootTracker("runtime-llm-retained-generation");
  const root = fs.realpathSync(roots.makeTempDir());
  fs.mkdirSync(path.join(root, "provider"));
  const fixture = createColdPluginFixture({
    rootDir: path.join(root, "provider"),
    pluginId: "retained-generation-provider",
    providerId: "retained-generation",
  });
  fs.writeFileSync(
    fixture.runtimeSource,
    `module.exports = { id: ${JSON.stringify(fixture.pluginId)}, register(api) {
      api.registerProvider({ id: ${JSON.stringify(fixture.providerId)}, label: "Retained", auth: [] });
    } };`,
  );
  let requests = 0;
  const server = createServer((request, response) => {
    request.resume();
    requests++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({
        id: "retained-response",
        object: "chat.completion.chunk",
        model: "retained-model",
        choices: [{ index: 0, delta: { content: "summary" }, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Completion fixture did not expose a TCP port");
    }
    const config: OpenClawConfig = {
      agents: { defaults: { workspace: root, model: `${fixture.providerId}/retained-model` } },
      models: {
        providers: {
          [fixture.providerId]: {
            api: "openai-completions",
            apiKey: "fixture-key",
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            models: [
              {
                id: "retained-model",
                name: "Retained model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 8192,
                maxTokens: 1024,
              },
            ],
          },
        },
      },
      plugins: {
        load: { paths: [fixture.rootDir] },
        slots: { memory: "none" },
        entries: { [fixture.pluginId]: { enabled: true } },
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
        const cache = createPluginCache();
        const metadata = withPluginCache(cache, () =>
          resolvePluginMetadataSnapshot({ config: cfg, workspaceDir: root }),
        );
        setGatewayPluginMetadataSnapshot(metadata, { config: cfg, workspaceDir: root });
        await refreshPreparedModelRuntimeSnapshots(cfg, publication);
        return cache;
      };
      try {
        const previousCache = await publish(config);
        // A turn creates the retained context engine under its admitted generation.
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
        // Another plugin's replacement publishes a new inventory and retires the old one.
        const replacement = { ...config, messages: { responsePrefix: "replacement" } };
        await publish(replacement);
        const retirement = retirePluginCache(previousCache);
        expect(() => retainPluginCache(previousCache)).toThrow("Plugin inventory has retired");
        const llm = createRuntimeLlm({ getConfig: () => replacement });
        const result = await engine.run(() =>
          llm.complete({ messages: [{ role: "user", content: "summarize" }] }),
        );
        expect(result.text).toBe("summary");
        expect(requests).toBe(1);
        await engine.release();
        await retirement;
      } finally {
        await resetPreparedModelRuntimeSnapshotsForTest();
        clearPluginMetadataLifecycleCaches();
        resetPluginLoaderTestStateForTest();
      }
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    roots.cleanup();
  }
});
