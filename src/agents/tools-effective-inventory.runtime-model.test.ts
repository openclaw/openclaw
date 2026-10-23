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
  const stores = { authStorage: { owner: "request" }, modelRegistry: { owner: "request" } };
  const model = (id: string) => ({ id, provider: "openai", api: "openai-responses" });
  const requestLease = {
    ...stores,
    snapshot: { createStores: () => stores },
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

it.each(["blank", "bundled", "configured"])(
  "uses %s context without a runtime lease",
  async (source) => {
    const alias = source === "configured";
    const modelId = alias ? "grok-4.3-latest" : source === "blank" ? " " : "bundled";
    const provider = alias ? "xai" : "openai";
    const compat = { supportsTools: true };
    const providerConfig = {
      baseUrl: "https://configured.example.invalid",
      api: "anthropic-messages" as const,
      models: [{ ...makeModel("grok-4.3"), name: "Configured", compat: { ...compat } }],
    };
    const cfg = makeOpenClawConfigFixture(
      alias ? { models: { providers: { [provider]: providerConfig } } } : {},
    );
    if (source === "bundled") {
      runtimeMocks.staticCatalogModel.mockReturnValue(runtimeMocks.model(modelId));
    }
    const acquired = await acquire(modelId, { cfg, modelProvider: provider });
    const context = acquired.run((value) => value);
    if (source === "blank") {
      expect(context).toEqual({});
    } else {
      expect(context).toMatchObject({
        modelApi: alias ? "anthropic-messages" : "openai-responses",
        runtimeModel: { id: modelId, provider, ...(alias ? { name: "Configured", compat } : {}) },
      });
    }
    if (alias) {
      expect(resolveConfiguredModelCompat({ cfg, modelProvider: provider, modelId })).toEqual(
        compat,
      );
    }
    await acquired[Symbol.asyncDispose]();
    expect(runtimeMocks.acquire).not.toHaveBeenCalled();
    expect(runtimeMocks.resolveModelAsync).not.toHaveBeenCalled();
    expect(runtimeMocks.requestLease[Symbol.asyncDispose]).not.toHaveBeenCalled();
  },
);

it("releases the runtime lease when dynamic model resolution fails", async () => {
  const failure = new Error("dynamic model failed");
  runtimeMocks.resolveModelAsync.mockRejectedValueOnce(failure);

  await expect(acquire("chat-latest")).rejects.toBe(failure);
  expect(runtimeMocks.requestLease[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
});
