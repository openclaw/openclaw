import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeModel,
  makeOpenClawConfigFixture,
} from "./embedded-agent-runner/model.test-harness.js";
import {
  acquireEffectiveToolInventoryRuntimeModelContext,
  resolveConfiguredModelCompat,
} from "./tools-effective-inventory.js";

const runtimeMocks = vi.hoisted(() => {
  const createLease = (owner: string) => {
    const authStorage = { owner };
    const modelRegistry = { owner };
    return {
      authStorage,
      modelRegistry,
      snapshot: {
        createStores: vi.fn(() => ({ authStorage, modelRegistry })),
      },
      [Symbol.asyncDispose]: vi.fn(async () => {}),
    };
  };
  const requestLease = createLease("request");
  return {
    acquire: vi.fn(async () => requestLease),
    requestLease,
    resolveModelAsync: vi.fn(async () => ({
      model: {
        id: "chat-latest",
        name: "chat-latest",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
    })),
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

describe("acquireEffectiveToolInventoryRuntimeModelContext", () => {
  beforeEach(() => {
    runtimeMocks.acquire.mockReset().mockResolvedValue(runtimeMocks.requestLease);
    runtimeMocks.requestLease.snapshot.createStores.mockClear();
    runtimeMocks.resolveModelAsync.mockClear();
    runtimeMocks.requestLease[Symbol.asyncDispose].mockClear();
    runtimeMocks.staticCatalogModel.mockReset();
  });

  it("prepares dynamic model context with a runtime lease", async () => {
    const lease = runtimeMocks.requestLease;
    const agentId = "main";
    const cfg = makeOpenClawConfigFixture();
    const agentDir = `/tmp/agents/${agentId}/agent`;
    const workspaceDir = `/tmp/workspace-${agentId}`;

    const acquired = await acquireEffectiveToolInventoryRuntimeModelContext({
      cfg,
      agentId,
      agentDir,
      workspaceDir,
      modelProvider: " OpenAI ",
      modelId: " chat-latest ",
    });
    expect(acquired.run((context) => context)).toMatchObject({
      modelApi: "openai-responses",
      runtimeModel: { id: "chat-latest", provider: "openai" },
    });
    expect(runtimeMocks.resolveModelAsync).toHaveBeenCalledWith(
      "openai",
      "chat-latest",
      agentDir,
      cfg,
      {
        agentId,
        workspaceDir,
        authStorage: lease.authStorage,
        modelRegistry: lease.modelRegistry,
        preparedModelRuntime: lease.snapshot,
      },
    );
    expect(runtimeMocks.acquire).toHaveBeenCalledWith(
      {
        agentId,
        agentDir,
        config: cfg,
        workspaceDir,
        loadRuntimePlugins: true,
        runtimePluginSelections: [{ provider: "openai", modelId: "chat-latest", agentId }],
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

  it("skips runtime preparation for a blank model id", async () => {
    const acquired = await acquireEffectiveToolInventoryRuntimeModelContext({
      cfg: {},
      modelProvider: "openai",
      modelId: " ",
    });
    expect(acquired.run((context) => context)).toEqual({});
    await acquired[Symbol.asyncDispose]();
    expect(runtimeMocks.acquire).not.toHaveBeenCalled();
    expect(runtimeMocks.resolveModelAsync).not.toHaveBeenCalled();
    expect(runtimeMocks.requestLease[Symbol.asyncDispose]).not.toHaveBeenCalled();
  });

  it("uses configured static-alias context without acquiring a runtime lease", async () => {
    const provider = "xai";
    const modelId = "grok-4.3-latest";
    const configuredModel = {
      ...makeModel("grok-4.3"),
      name: "Configured",
      contextWindow: 8192,
      maxTokens: 1024,
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

    const acquired = await acquireEffectiveToolInventoryRuntimeModelContext({
      cfg,
      modelProvider: provider,
      modelId,
    });
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
    await acquired[Symbol.asyncDispose]();
    expect(runtimeMocks.acquire).not.toHaveBeenCalled();
    expect(runtimeMocks.resolveModelAsync).not.toHaveBeenCalled();
    expect(runtimeMocks.requestLease[Symbol.asyncDispose]).not.toHaveBeenCalled();
  });

  it("uses bundled model context without acquiring a runtime lease", async () => {
    runtimeMocks.staticCatalogModel.mockReturnValue({
      id: "bundled",
      name: "Bundled",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });

    const acquired = await acquireEffectiveToolInventoryRuntimeModelContext({
      cfg: {},
      modelProvider: "openai",
      modelId: "bundled",
    });
    expect(acquired.run((context) => context)).toMatchObject({
      modelApi: "openai-responses",
      runtimeModel: { id: "bundled", provider: "openai" },
    });
    await acquired[Symbol.asyncDispose]();
    expect(runtimeMocks.acquire).not.toHaveBeenCalled();
    expect(runtimeMocks.resolveModelAsync).not.toHaveBeenCalled();
    expect(runtimeMocks.requestLease[Symbol.asyncDispose]).not.toHaveBeenCalled();
  });

  it("releases the runtime lease when dynamic model resolution fails", async () => {
    const failure = new Error("dynamic model failed");
    runtimeMocks.resolveModelAsync.mockRejectedValueOnce(failure);

    await expect(
      acquireEffectiveToolInventoryRuntimeModelContext({
        cfg: {},
        modelProvider: "openai",
        modelId: "chat-latest",
      }),
    ).rejects.toBe(failure);
    expect(runtimeMocks.requestLease[Symbol.asyncDispose]).toHaveBeenCalledTimes(1);
  });
});
