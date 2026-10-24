// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "../agents/prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { refreshPreparedModelRuntimeSnapshots } from "../agents/prepared-model-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { model } from "./server-chat-metadata-lifecycle.auth.test-support.js";
import { createGatewayChatMetadataLifecycle } from "./server-chat-metadata-lifecycle.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createGatewaySidecarStopOwner } from "./server-sidecar-owners.js";

const mocks = getPreparedModelRuntimeMocks();
const config = {
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.4" },
      models: { "openai/gpt-5.4": {} },
      modelPolicy: { allow: ["openai/gpt-5.4"] },
    },
    entries: { main: {} },
  },
} as OpenClawConfig;
const signedIn = {
  version: 1,
  profiles: { "openai:default": { type: "api_key", provider: "openai", key: "sk-test" } },
} as const;
let state: OpenClawTestState;
let sidecars = createGatewaySidecarStopOwner();

beforeEach(async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  state = await createOpenClawTestState({ label: "metadata-rebuild" });
  await resetPreparedModelRuntimeHarness(state);
  mocks.configuredAgentIds = ["main"];
  mocks.authStorage.getAll.mockReturnValue({ openai: { type: "api_key", key: "sk-test" } });
  mocks.preparedAuthStore = structuredClone(signedIn);
  mocks.buildPreparedModelCatalogSnapshot.mockResolvedValue({
    entries: [model],
    routeVariants: [model],
  });
  sidecars = createGatewaySidecarStopOwner();
});

afterEach(async ({ task }) => {
  await sidecars.stop();
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
  vi.unstubAllEnvs();
});

const publishOwner = () =>
  refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "live",
    allowGatewaySubagentBinding: true,
  });

it("serves the published list while a provider never answers", async () => {
  await publishOwner();
  const lifecycle = await createGatewayChatMetadataLifecycle({
    getConfig: () => config,
    log: { warn: vi.fn() } as never,
  });
  await lifecycle.attachContext(
    {
      broadcast: vi.fn(),
      getRuntimeConfig: () => config,
      logGateway: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as GatewayRequestContext,
    sidecars.publish,
  );
  const read = async () => {
    // The replacement below never settles; a read that waits on it fails this budget.
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("models.list waited for the rebuild")), 1_000);
    });
    try {
      const result = await Promise.race([
        lifecycle.readModelsList({
          agentId: "main",
          params: { view: "configured" },
          includeManualSelection: false,
        }),
        budget,
      ]);
      return result?.models.map(({ provider, id }) => `${provider}/${id}`);
    } finally {
      clearTimeout(timer);
    }
  };
  expect(await read()).toContain("openai/gpt-5.4");
  const discovery = createDeferredCore<{ entries: (typeof model)[]; routeVariants: [] }>();
  mocks.buildPreparedModelCatalogSnapshot.mockImplementationOnce(() => discovery.promise);
  const rebuild = publishOwner().catch((error: unknown) => error);
  try {
    expect(await read()).toContain("openai/gpt-5.4");
  } finally {
    discovery.resolve({ entries: [model], routeVariants: [] });
    await rebuild;
  }
});
