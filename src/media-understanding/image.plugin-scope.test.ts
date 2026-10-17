import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createSyncSuiteTempRootTracker } from "../plugins/test-helpers/fs-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import { resolveImageRuntime } from "./image-model-runtime.js";

const roots = createSyncSuiteTempRootTracker("openclaw-image-plugin-scope");

afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  roots.cleanup();
});

it("prepares the image provider without evaluating configured memory or context plugins", async () => {
  const root = roots.makeTempDir();
  const createFixture = (id: string) => {
    const rootDir = path.join(root, id);
    fs.mkdirSync(rootDir);
    return createColdPluginFixture({
      rootDir,
      pluginId: id,
      providerId: id,
      manifest: id === "expensive-memory" ? { kind: "memory" } : {},
      runtimeMessage: "Image preparation must not evaluate agent-owned plugins",
    });
  };
  const provider = createFixture("image-provider");
  const memory = createFixture("expensive-memory");
  const context = createFixture("expensive-context");
  const fixtures = [provider, memory, context];
  fs.writeFileSync(
    provider.runtimeSource,
    `require("node:fs").writeFileSync(${JSON.stringify(provider.runtimeMarker)}, "loaded");
module.exports = { id: "image-provider", register(api) {
  api.registerProvider({ id: "image-provider", label: "Image fixture", auth: [] });
} };`,
  );
  const cfg: OpenClawConfig = {
    agents: { defaults: { workspace: path.join(root, "workspace") } },
    plugins: {
      load: { paths: fixtures.map((fixture) => fixture.rootDir) },
      slots: { memory: memory.pluginId, contextEngine: context.pluginId },
      entries: Object.fromEntries(fixtures.map((fixture) => [fixture.pluginId, { enabled: true }])),
    },
    models: {
      providers: {
        "image-provider": {
          baseUrl: "https://image-fixture.example/v1",
          api: "openai-completions",
          apiKey: "synthetic-image-fixture",
          models: [
            {
              id: "vision",
              name: "Vision fixture",
              reasoning: false,
              input: ["text", "image"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16_000,
              maxTokens: 4_096,
            },
          ],
        },
      },
    },
  };
  await withEnvAsync(
    {
      ...createColdPluginHermeticEnv(root, { bundledPluginsDir: roots.makeTempDir() }),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: path.join(root, "state"),
    },
    async () => {
      let resources: AsyncDisposable | undefined;
      try {
        const runtime = await resolveImageRuntime(
          {
            cfg,
            agentId: "main",
            agentDir: path.join(root, "agent"),
            provider: provider.providerId,
            model: "vision",
            authStore: { version: 1, profiles: {} },
          },
          (acquired) => {
            resources = acquired;
          },
        );
        expect(runtime.model).toMatchObject({ provider: "image-provider", id: "vision" });
        expect(isColdPluginRuntimeLoaded(provider)).toBe(true);
        expect(isColdPluginRuntimeLoaded(memory)).toBe(false);
        expect(isColdPluginRuntimeLoaded(context)).toBe(false);
      } finally {
        await resources?.[Symbol.asyncDispose]();
      }
    },
  );
});
