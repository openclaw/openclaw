import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelChoice } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import * as catalog from "../../agents/prepared-model-catalog.js";
import { setPreparedModelRuntimeAuthStore } from "../../agents/prepared-model-runtime-auth.js";
import { markPreparedModelCatalogFull } from "../../agents/prepared-model-runtime.full-catalog.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.types.js";
import * as runtimeConfig from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as gateway from "../../gateway/call.js";
import * as gatewayLock from "../../infra/gateway-lock.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { modelsListCommand } from "./list.list-command.js";
import * as configLoader from "./load-config.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
  writeJson: vi.fn(),
  writeStdout: vi.fn(),
};
const model: ModelChoice = {
  provider: "catalog-provider",
  id: "Reader",
  name: "Reader model",
  input: ["text", "image"],
  contextWindow: 128000,
  contextTokens: 64000,
  local: true,
  available: true,
  alias: "work",
  tags: ["default"],
};
const cfg: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    entries: { work: { workspace: "/tmp/published-cli-work" } },
    defaults: { model: { primary: "catalog-provider/Reader" } },
  },
  models: {
    providers: {
      "catalog-provider": {
        api: "anthropic-messages",
        baseUrl: "https://catalog.example.test",
        models: [],
      },
    },
  },
};
function createOwner(): PreparedModelRuntimeSnapshot {
  const entry = {
    provider: "catalog-provider",
    id: "Reader",
    name: "Reader model",
    api: "anthropic-messages" as const,
    baseUrl: "https://catalog.example.test",
    input: ["text" as const],
    contextWindow: 128000,
  };
  const owner: PreparedModelRuntimeSnapshot = {
    catalogOwner: { agentId: "work", workspaceDir: "/tmp/published-cli-work" },
    agentId: "work",
    agentDir: "/tmp/published-cli-agent",
    workspaceDir: "/tmp/published-cli-work",
    activeProjectKeys: [],
    config: cfg,
    observationConfig: cfg,
    isCurrent: () => true,
    authModes: { "catalog-provider": "api_key" },
    metadataSnapshot: createPluginMetadataSnapshotFixture(),
    allowGatewaySubagentBinding: false,
    modelCatalog: markPreparedModelCatalogFull({ entries: [entry], routeVariants: [entry] }),
    configuredRuntimeModels: [],
    inlineProviderModels: [],
    createStores() {
      throw new Error("Inventory must not start model execution");
    },
  };
  setPreparedModelRuntimeAuthStore(owner, {
    version: 1,
    profiles: {
      "catalog-provider:test": {
        type: "api_key",
        provider: "catalog-provider",
        key: "synthetic-catalog-key",
      },
    },
  });
  return owner;
}
let owner: PreparedModelRuntimeSnapshot;
beforeEach(() => {
  vi.clearAllMocks();
  owner = createOwner();
  vi.spyOn(runtimeConfig, "getRuntimeConfig").mockReturnValue(cfg);
  vi.spyOn(configLoader, "loadModelsConfigWithSource").mockResolvedValue({
    sourceConfig: cfg,
    resolvedConfig: cfg,
    diagnostics: [],
  });
  vi.spyOn(gateway, "isImplicitLocalGatewayTarget").mockResolvedValue(true);
  vi.spyOn(gatewayLock, "readActiveGatewayLockIdentity").mockResolvedValue({
    pid: 123,
    port: 19001,
    createdAt: "fixture",
  });
  vi.spyOn(gateway, "callGateway").mockResolvedValue({ models: [model] });
  vi.spyOn(catalog, "withPreparedModelCatalogOwner").mockImplementation(
    async (_params, read) => await read(owner),
  );
});
afterEach(() => vi.restoreAllMocks());

async function list(options: Parameters<typeof modelsListCommand>[0]) {
  return withEnvAsync({ OPENCLAW_GATEWAY_PORT: undefined }, () =>
    modelsListCommand(options, runtime),
  );
}

describe("models list published transport", () => {
  it("does not resolve local provider secrets for a selected Gateway", async () => {
    vi.mocked(configLoader.loadModelsConfigWithSource).mockRejectedValue(
      new Error("Local provider secret unavailable"),
    );
    await list({ json: true });
    expect(configLoader.loadModelsConfigWithSource).not.toHaveBeenCalled();
    expect(runtime.writeJson).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }), 2);
  });

  it.each([false, true])("reads the selected Gateway with refresh=%s", async (refresh) => {
    await list({ agent: "work", provider: "catalog-provider", local: true, json: true, refresh });
    expect(catalog.withPreparedModelCatalogOwner).not.toHaveBeenCalled();
    expect(gateway.callGateway).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        requiredCapabilities: ["published-model-catalog"],
        localPortOverride: 19001,
        params: {
          agentId: "work",
          view: "all",
          provider: "catalog-provider",
          includeDetails: true,
          ...(refresh ? { refresh: true } : {}),
        },
      }),
    );
    expect(vi.mocked(gateway.callGateway).mock.calls[0]?.[0].timeoutMs).toBe(
      refresh ? 210_000 : undefined,
    );
    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        count: 1,
        models: [
          {
            key: "catalog-provider/Reader",
            name: "Reader model",
            input: "text+image",
            contextWindow: 128000,
            contextTokens: 64000,
            local: true,
            available: true,
            tags: ["default", "alias:work"],
          },
        ],
      },
      2,
    );
  });

  it.each([
    "Gateway rejected authorization",
    "active gateway does not support required capability",
    "Gateway connection unavailable",
  ])("does not substitute local inventory for %s", async (message) => {
    const failure = new Error(message);
    vi.mocked(gateway.callGateway).mockRejectedValue(failure);
    await expect(list({ all: true, json: true })).rejects.toBe(failure);
    expect(catalog.withPreparedModelCatalogOwner).not.toHaveBeenCalled();
    expect(runtime.writeJson).not.toHaveBeenCalled();
  });

  it("uses a selected remote Gateway without reading a local lock owner", async () => {
    vi.mocked(gateway.isImplicitLocalGatewayTarget).mockResolvedValue(false);
    await list({ json: true });
    expect(gatewayLock.readActiveGatewayLockIdentity).not.toHaveBeenCalled();
    expect(catalog.withPreparedModelCatalogOwner).not.toHaveBeenCalled();
    expect(gateway.callGateway).toHaveBeenCalledExactlyOnceWith(
      expect.not.objectContaining({ localPortOverride: expect.anything() }),
    );
  });

  it("treats an explicit Gateway port as a selected target even without a local lock", async () => {
    await withEnvAsync({ OPENCLAW_GATEWAY_PORT: "19002" }, () =>
      modelsListCommand({ json: true }, runtime),
    );
    expect(gatewayLock.readActiveGatewayLockIdentity).not.toHaveBeenCalled();
    expect(catalog.withPreparedModelCatalogOwner).not.toHaveBeenCalled();
    expect(gateway.callGateway).toHaveBeenCalledOnce();
  });

  it("preserves unknown auth and missing capability fields", async () => {
    vi.mocked(gateway.callGateway).mockResolvedValue({
      models: [{ provider: "catalog-provider", id: "reader", name: "Unknown route" }],
    });
    await list({ json: true });
    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        count: 1,
        models: [
          {
            key: "catalog-provider/reader",
            name: "Unknown route",
            input: "-",
            contextWindow: null,
            local: null,
            available: null,
            tags: [],
          },
        ],
      },
      2,
    );
  });

  it("keeps successful empty inventory empty", async () => {
    vi.mocked(gateway.callGateway).mockResolvedValue({ models: [] });
    await list({ json: true, refresh: true });
    expect(runtime.writeJson).toHaveBeenCalledWith({ count: 0, models: [] }, 2);
    expect(catalog.withPreparedModelCatalogOwner).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("shows a refresh warning while retaining the returned published rows", async () => {
    vi.mocked(gateway.callGateway).mockResolvedValue({
      models: [model],
      providerOutcomes: [{ provider: "catalog-provider", status: "unavailable" }],
    });
    await list({ refresh: true, json: true });
    expect(runtime.error).toHaveBeenCalledWith(
      "Model discovery could not refresh all providers. Showing the available published model list.",
    );
    expect(runtime.writeJson).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }), 2);
  });

  it.each([false, true])(
    "uses the standalone owner only with no selected Gateway, refresh=%s",
    async (refresh) => {
      vi.mocked(gatewayLock.readActiveGatewayLockIdentity).mockResolvedValue(undefined);
      await list({ agent: "work", all: true, json: true, refresh });
      expect(gateway.callGateway).not.toHaveBeenCalled();
      expect(catalog.withPreparedModelCatalogOwner).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          agentId: "work",
          readOnly: !refresh,
          ...(refresh ? { refreshFullCatalog: true } : {}),
        }),
        expect.any(Function),
      );
      expect(runtime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          count: 1,
          models: [
            expect.objectContaining({ key: "catalog-provider/Reader", contextWindow: 128000 }),
          ],
        }),
        2,
      );
    },
  );
  it("rejects conflicting output flags before reading any catalog", async () => {
    await expect(list({ json: true, plain: true })).rejects.toThrow(
      "Choose either --json or --plain",
    );
    expect(gateway.callGateway).not.toHaveBeenCalled();
    expect(catalog.withPreparedModelCatalogOwner).not.toHaveBeenCalled();
  });

  it("rejects provider display labels before reading a catalog", async () => {
    await expect(list({ provider: "Example Provider", json: true })).rejects.toThrow(
      "Invalid provider filter",
    );
    expect(gateway.callGateway).not.toHaveBeenCalled();
  });

  it("filters only proven local rows and renders their exact keys in plain output", async () => {
    vi.mocked(gateway.callGateway).mockResolvedValue({
      models: [
        model,
        { ...model, id: "remote", local: false },
        { provider: "catalog-provider", id: "unknown", name: "Unknown" },
      ],
    });
    await list({ local: true, plain: true });
    expect(runtime.writeStdout).toHaveBeenCalledExactlyOnceWith("catalog-provider/Reader");
    expect(runtime.writeJson).not.toHaveBeenCalled();
  });

  it("keeps an empty plain list machine-readable", async () => {
    vi.mocked(gateway.callGateway).mockResolvedValue({ models: [] });
    await list({ plain: true });
    expect(runtime.writeStdout).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });
});
