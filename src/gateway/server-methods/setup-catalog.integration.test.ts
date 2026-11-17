// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "../../agents/prepared-model-runtime.test-harness.js";
import { afterEach, expect, it, vi } from "vitest";
import { mockOAuthProviderOperations } from "../../agents/auth-profiles/oauth-native-provider.test-support.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import * as catalogWorker from "../../agents/prepared-model-catalog-worker.js";
import {
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "../../agents/prepared-model-runtime.js";
import { ModelRegistry } from "../../agents/sessions/model-registry.js";
import { makeProviderModelFixture } from "../../agents/test-helpers/provider-model-fixture.js";
import { createZeroUsageFixture } from "../../agents/test-helpers/usage-fixtures.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import {
  hashRuntimeConfigValue,
  setRuntimeConfigAppliedHash,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { acquireTestPortBlock } from "../../test-utils/port-claims.js";
import { startGatewayServer } from "../server.js";
import { connectGatewayClient, disconnectGatewayClient } from "../test-helpers.e2e.js";

const transport = vi.hoisted(() => ({
  stream: vi.fn<typeof import("../../llm/stream.js").streamSimple>(),
}));
const fixture = usePreparedModelRuntimeHarness({
  label: "setup-verify",
  env: {
    OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
  },
});
afterEach(() => {
  transport.stream.mockReset();
});

it("verifies the public setup request using the startup subscription route", async () => {
  const { mocks, state } = fixture;
  mockOAuthProviderOperations();
  mocks.configuredAgentIds = ["pro"];
  mocks.resolveNativeModelPrimary.mockReturnValue("openai/subscription-model");
  const oauth = {
    type: "oauth" as const,
    provider: "openai",
    access: "synthetic-access",
    refresh: "synthetic-refresh",
    expires: Date.now() + 3600000,
  };
  mocks.preparedAuthStore = { version: 1, profiles: { "openai:fixture": oauth } };
  await state.writeAuthProfiles(mocks.preparedAuthStore, "pro");
  mocks.authStorage.getAll.mockReturnValue({ openai: oauth });
  const row: ModelCatalogEntry = {
    provider: "openai",
    id: "subscription-model",
    name: "Subscription model",
    api: "openai-chatgpt-responses",
    contextWindow: 128000,
    reasoning: true,
  };
  mocks.runPreparedModelCatalogWorker.mockResolvedValue({ entries: [row], routeVariants: [row] });
  mocks.resolveStaticCatalogModel.mockReturnValue(
    makeProviderModelFixture({
      provider: "openai",
      id: row.id,
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    }),
  );
  const config: OpenClawConfig = {
    plugins: { enabled: false },
    agents: {
      defaults: {
        model: "openai/subscription-model",
        models: { "openai/subscription-model": { agentRuntime: { id: "openclaw" } } },
      },
      entries: { pro: { workspace: state.workspaceDir } },
    },
    auth: {
      profiles: { "openai:fixture": { provider: "openai", mode: "oauth" } },
      order: { openai: ["openai:fixture"] },
    },
  };
  const runtimeModel = makeProviderModelFixture({
    provider: "openai",
    id: row.id,
    api: "openai-chatgpt-responses",
    baseUrl: "https://chatgpt.com/backend-api",
  });
  const createWorker = catalogWorker.createPreparedModelCatalogWorker;
  vi.spyOn(catalogWorker, "createPreparedModelCatalogWorker").mockImplementation((params) => {
    const worker = createWorker(params);
    return {
      ...worker,
      loadCatalog: async (...args) => ({
        ...(await worker.loadCatalog(...args)),
        runtimeModels: new Map([["openai", [runtimeModel]]]),
      }),
    };
  });
  mocks.modelRegistry.fork.mockImplementation(
    (authStorage, publishedModels?: Parameters<ModelRegistry["fork"]>[1]) => {
      const registry = ModelRegistry.fromCapturedSources(authStorage, state.path("models.json"), {
        config,
        modelsJsonContents: null,
        includePluginCatalogs: false,
        pluginCatalogs: [],
        pluginMetadataSnapshot: mocks.pluginMetadataSnapshot,
      }).fork(authStorage, publishedModels);
      registry.registerProvider("openai", {
        api: "openai-chatgpt-responses",
        streamSimple: transport.stream,
      });
      return registry;
    },
  );
  await state.writeConfig(config);
  const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  const server = await startGatewayServer(claim.port, {
    bind: "loopback",
    auth: { mode: "token", token: "synthetic-setup-token" },
    controlUiEnabled: false,
  });
  try {
    await server.startupSettled;
    const snapshot = await readConfigFileSnapshot();
    expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
    const runtimeConfig = snapshot.runtimeConfig ?? snapshot.config;
    setRuntimeConfigSnapshot(runtimeConfig, snapshot.sourceConfig);
    setRuntimeConfigAppliedHash(hashRuntimeConfigValue(snapshot.sourceConfig));
    await refreshPreparedModelRuntimeSnapshots(runtimeConfig, {
      gatewayLifecycle: true,
      catalogMode: "static",
    });
    const published = await prepareModelRuntimeSnapshot(fixture.agentInput("pro", runtimeConfig));
    await published.loadFullModelCatalog!({ refresh: true, wait: true });
    transport.stream.mockImplementation((model) => {
      expect(model.api).toBe("openai-chatgpt-responses");
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "OK" }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: createZeroUsageFixture(),
            stopReason: "stop",
            timestamp: Date.now(),
          },
        });
      });
      return stream;
    });
    const client = await connectGatewayClient({
      url: `ws://127.0.0.1:${claim.port}`,
      token: "synthetic-setup-token",
      scopes: ["operator.admin", "operator.read", "operator.write"],
    });
    let result: unknown;
    try {
      result = await client.request("openclaw.setup.verify", { agentId: "pro" });
    } finally {
      await disconnectGatewayClient(client);
    }
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      modelRef: "openai/subscription-model",
    });
    expect(transport.stream).toHaveBeenCalledOnce();
  } finally {
    await server.close();
    await claim.release();
  }
}, 120_000);
