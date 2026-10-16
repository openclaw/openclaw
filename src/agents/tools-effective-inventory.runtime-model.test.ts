import { beforeEach, expect, it, vi } from "vitest";
import {
  makeModel,
  makeOpenClawConfigFixture,
} from "./embedded-agent-runner/model.test-harness.js";
import {
  acquireEffectiveToolInventoryRuntimeModelContext as acquireContext,
  resolveConfiguredModelCompat,
} from "./tools-effective-inventory.js";

const runtimeMocks = vi.hoisted(() => {
  const authStorage = { owner: "request" };
  const modelRegistry = { owner: "request" };
  const model = (id: string) => ({
    id,
    name: id,
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  });
  const requestLease = {
    authStorage,
    modelRegistry,
    snapshot: { createStores: () => ({ authStorage, modelRegistry }) },
    [Symbol.asyncDispose]: vi.fn(async () => {}),
  };
  return {
    acquire: vi.fn(async () => requestLease),
    requestLease,
    model,
    resolveModelAsync: vi.fn(async () => ({ model: model("chat-latest") })),
    staticCatalogModel: vi.fn(),
  };
});

vi.mock("../plugins/runtime/generation-scope.js", () => ({
  withPluginRuntimeGenerationScope: (_generation: unknown, run: () => unknown) => run(),
}));

vi.mock("./prepared-model-runtime.js", () => ({
  acquireReadOnlyPreparedModelRuntime: runtimeMocks.acquire,
}));

vi.mock("./embedded-agent-runner/model.js", () => ({
  resolveModelAsync: runtimeMocks.resolveModelAsync,
}));

vi.mock("./embedded-agent-runner/model.static-catalog.js", () => ({
  resolveBundledStaticCatalogModel: runtimeMocks.staticCatalogModel,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  normalizeProviderTransportWithPlugin: () => undefined,
}));

vi.mock("./agent-scope.js", () => ({
  resolveAgentDir: () => "/tmp/agents/main/agent",
  resolveAgentWorkspaceDir: () => "/tmp/workspace-main",
  resolveDefaultAgentDir: () => "/tmp/agents/main/agent",
  resolveSessionAgentId: () => "main",
}));

const location = {
  agentId: "main",
  agentDir: "/tmp/agents/main/agent",
  workspaceDir: "/tmp/workspace-main",
};
function acquire(modelId: string, overrides: Partial<Parameters<typeof acquireContext>[0]> = {}) {
  return acquireContext({
    cfg: {},
    modelProvider: "openai",
    modelId,
    ...overrides,
  });
}
async function expectNoRuntimeLease(acquired: Awaited<ReturnType<typeof acquire>>) {
  await acquired[Symbol.asyncDispose]();
  expect(runtimeMocks.acquire).not.toHaveBeenCalled();
  expect(runtimeMocks.resolveModelAsync).not.toHaveBeenCalled();
  expect(runtimeMocks.requestLease[Symbol.asyncDispose]).not.toHaveBeenCalled();
}

beforeEach(() => {
  runtimeMocks.acquire.mockReset().mockResolvedValue(runtimeMocks.requestLease);
  runtimeMocks.resolveModelAsync.mockClear();
  runtimeMocks.requestLease[Symbol.asyncDispose].mockClear();
  runtimeMocks.staticCatalogModel.mockReset();
});

it("prepares dynamic model context with a runtime lease", async () => {
  const lease = runtimeMocks.requestLease;
  const cfg = makeOpenClawConfigFixture();

  const acquired = await acquire(" chat-latest ", {
    cfg,
    ...location,
    modelProvider: " OpenAI ",
  });
  expect(acquired.run((context) => context)).toMatchObject({
    modelApi: "openai-responses",
    runtimeModel: { id: "chat-latest", provider: "openai" },
  });
  expect(runtimeMocks.resolveModelAsync).toHaveBeenCalledWith(
    "openai",
    "chat-latest",
    location.agentDir,
    cfg,
    {
      agentId: location.agentId,
      workspaceDir: location.workspaceDir,
      authStorage: lease.authStorage,
      modelRegistry: lease.modelRegistry,
      preparedModelRuntime: lease.snapshot,
    },
  );
  expect(runtimeMocks.acquire).toHaveBeenCalledWith(
    {
      ...location,
      config: cfg,
      loadRuntimePlugins: true,
      runtimePluginSelections: [
        { provider: "openai", modelId: "chat-latest", agentId: location.agentId },
      ],
      allowGatewaySubagentBinding: true,
    },
    { catalogMode: "static" },
  );
  expect(lease[Symbol.asyncDispose]).not.toHaveBeenCalled();
  await acquired[Symbol.asyncDispose]();
  await acquired[Symbol.asyncDispose]();
  expect(lease[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
  expect(() => acquired.run(() => undefined)).toThrow("has been released");
});

it.each([" ", "bundled"])("uses static context without a runtime lease for %j", async (modelId) => {
  if (modelId === "bundled") {
    runtimeMocks.staticCatalogModel.mockReturnValue(runtimeMocks.model(modelId));
  }
  const acquired = await acquire(modelId);
  const context = acquired.run((value) => value);
  if (modelId === "bundled") {
    expect(context).toMatchObject({
      modelApi: "openai-responses",
      runtimeModel: { id: modelId, provider: "openai" },
    });
  } else {
    expect(context).toEqual({});
  }
  await expectNoRuntimeLease(acquired);
});

it("uses configured static-alias context without acquiring a runtime lease", async () => {
  const provider = "xai";
  const modelId = "grok-4.3-latest";
  const configuredModel = {
    ...makeModel("grok-4.3"),
    name: "Configured",
    compat: { supportsTools: true },
  };
  const cfg = makeOpenClawConfigFixture({
    models: {
      providers: {
        [provider]: {
          baseUrl: "https://configured.example.invalid",
          api: "anthropic-messages",
          models: [configuredModel],
        },
      },
    },
  });

  const acquired = await acquire(modelId, { cfg, modelProvider: provider });
  expect(acquired.run((context) => context)).toMatchObject({
    modelApi: "anthropic-messages",
    runtimeModel: {
      id: modelId,
      name: "Configured",
      provider,
      compat: { supportsTools: true },
    },
  });
  expect(resolveConfiguredModelCompat({ cfg, modelProvider: provider, modelId })).toEqual({
    supportsTools: true,
  });
  await expectNoRuntimeLease(acquired);
});

it("releases the runtime lease when dynamic model resolution fails", async () => {
  const failure = new Error("dynamic model failed");
  runtimeMocks.resolveModelAsync.mockRejectedValueOnce(failure);

  await expect(acquire("chat-latest")).rejects.toBe(failure);
  expect(runtimeMocks.requestLease[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
});
