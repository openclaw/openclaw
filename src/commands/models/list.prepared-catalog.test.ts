import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelChoice } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { visibleWidth } from "../../../packages/terminal-core/src/ansi.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import { createModelRuntimeChoiceOwnerFixture } from "../../agents/model-runtime-choice.test-support.js";
import * as catalog from "../../agents/prepared-model-catalog.js";
import { bindPreparedModelRuntimeAuth } from "../../agents/prepared-model-runtime-auth.js";
import { markPreparedModelCatalogFull } from "../../agents/prepared-model-runtime.full-catalog.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.types.js";
import * as localStateOwner from "../../cli/local-state-owner.js";
import * as runtimeConfig from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as gateway from "../../gateway/call.js";
import * as gatewayLock from "../../infra/gateway-lock.js";
import * as proxyLifecycle from "../../infra/net/proxy/proxy-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { modelsListCommand } from "./list.list-command.js";
import type { ModelRow } from "./list.types.js";
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
function createOwner(
  overrides: Partial<PreparedModelRuntimeSnapshot> = {},
): PreparedModelRuntimeSnapshot {
  const entry = {
    ...model,
    api: "anthropic-messages" as const,
    baseUrl: "https://catalog.example.test",
    input: ["text" as const],
  };
  const owner: PreparedModelRuntimeSnapshot = {
    ...createModelRuntimeChoiceOwnerFixture(cfg),
    catalogOwner: { agentId: "work", workspaceDir: "/tmp/published-cli-work" },
    agentId: "work",
    agentDir: "/tmp/published-cli-agent",
    workspaceDir: "/tmp/published-cli-work",
    authModes: { "catalog-provider": "api_key" },
    modelCatalog: markPreparedModelCatalogFull({ entries: [entry], routeVariants: [entry] }),
    createStores() {
      throw new Error("Inventory must not start model execution");
    },
    ...overrides,
  };
  bindPreparedModelRuntimeAuth(owner, {
    store: createAuthProfileStoreFixture({
      "catalog-provider:test": createApiKeyCredential("catalog-provider", "synthetic-catalog-key"),
    }),
  });
  return owner;
}
let owner: PreparedModelRuntimeSnapshot;
beforeEach(() => {
  vi.clearAllMocks();
  owner = createOwner();
  vi.spyOn(localStateOwner, "runWithLocalStateOwner").mockImplementation(async ({ runLocal }) =>
    runLocal({
      config: cfg,
      env: process.env,
      signal: new AbortController().signal,
      assertCurrent() {},
    }),
  );
  vi.spyOn(runtimeConfig, "captureRuntimeConfigAsyncReader").mockReturnValue(
    Object.assign(
      async () => {
        runtimeConfig.setRuntimeConfigSnapshot(cfg, cfg);
        return cfg;
      },
      { assertCurrent() {} },
    ),
  );
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
  vi.spyOn(proxyLifecycle, "startProxy").mockResolvedValue(null);
  vi.spyOn(proxyLifecycle, "stopProxy").mockResolvedValue();
  vi.spyOn(catalog, "withPreparedModelCatalogOwner").mockImplementation(
    async (_params, read) => await read(owner),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  runtimeConfig.clearRuntimeConfigSnapshot();
});

async function list(options: Parameters<typeof modelsListCommand>[0]) {
  return withEnvAsync({ OPENCLAW_GATEWAY_PORT: undefined }, () =>
    modelsListCommand(options, runtime),
  );
}

function expectModelRows(models: Partial<ModelRow>[], details: Record<string, unknown> = {}) {
  expect(runtime.writeJson).toHaveBeenCalledWith(
    expect.objectContaining({
      models: models.map((row) => expect.objectContaining(row)),
      ...details,
    }),
    2,
  );
}

describe("models list published transport", () => {
  it.each(["ready", "unavailable"] as const)(
    "reports configured ids missing from a %s listing without changing availability",
    async (status) => {
      vi.mocked(gatewayLock.readActiveGatewayLockIdentity).mockResolvedValue(undefined);
      owner = createOwner({
        modelCatalog: markPreparedModelCatalogFull({
          ...createOwner().modelCatalog,
          providerOutcomes: [
            {
              provider: "catalog-provider",
              status,
              unlistedConfiguredModelIds: ["Reader", "Absent"],
            },
          ],
        }),
      });
      await list({ json: true });
      expectModelRows(
        [{ key: "catalog-provider/Reader", available: true, tags: ["default", "alias:work"] }],
        {
          providerOutcomes: [
            {
              provider: "catalog-provider",
              status,
              ...(status === "ready" ? { unlistedConfiguredModelIds: ["Reader", "Absent"] } : {}),
            },
          ],
        },
      );
      const warnings = runtime.error.mock.calls
        .map(([message]) => message)
        .filter((message) => String(message).includes("last successful server catalog"));
      expect(warnings).toEqual(
        status === "ready"
          ? ["Reader", "Absent"].map((id) =>
              expect.stringContaining(`Configured model "catalog-provider/${id}" is not present`),
            )
          : [],
      );
    },
  );

  it("refreshes the selected Gateway's inventory without resolving local provider secrets", async () => {
    vi.mocked(configLoader.loadModelsConfigWithSource).mockRejectedValue(
      new Error("Local provider secret unavailable"),
    );
    vi.mocked(gateway.callGateway).mockResolvedValue({
      models: [model, { provider: "catalog-provider", id: "reader", name: "Unknown route" }],
    });
    await list({ agent: "work", provider: "catalog-provider", json: true, refresh: true });
    expect(configLoader.loadModelsConfigWithSource).not.toHaveBeenCalled();
    expect(catalog.withPreparedModelCatalogOwner).not.toHaveBeenCalled();
    expect(proxyLifecycle.startProxy).not.toHaveBeenCalled();
    expect(localStateOwner.runWithLocalStateOwner).not.toHaveBeenCalled();
    expect(gateway.callGateway).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        requiredCapabilities: ["published-model-catalog"],
        localPortOverride: 19001,
        timeoutMs: 210_000,
        params: {
          agentId: "work",
          view: "all",
          provider: "catalog-provider",
          includeDetails: true,
          refresh: true,
        },
      }),
    );
    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        count: 2,
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

  it("does not substitute local inventory after Gateway authorization fails", async () => {
    const failure = new Error("Gateway rejected authorization");
    vi.mocked(gateway.callGateway).mockRejectedValue(failure);
    await expect(list({ all: true, json: true })).rejects.toBe(failure);
    expect(catalog.withPreparedModelCatalogOwner).not.toHaveBeenCalled();
    expect(runtime.writeJson).not.toHaveBeenCalled();
  });

  it("treats an explicit Gateway port as a selected target even without a local lock", async () => {
    await withEnvAsync({ OPENCLAW_GATEWAY_PORT: "19002" }, () =>
      modelsListCommand({ json: true }, runtime),
    );
    expect(gatewayLock.readActiveGatewayLockIdentity).not.toHaveBeenCalled();
    expect(catalog.withPreparedModelCatalogOwner).not.toHaveBeenCalled();
    expect(gateway.callGateway).toHaveBeenCalledOnce();
  });

  it("reports rejected discovery with empty provider inventory in text", async () => {
    const outcome = { provider: "xai", profileId: "xai:work", status: "auth-rejected" };
    vi.mocked(gateway.callGateway).mockResolvedValue({
      models: [],
      providerOutcomes: [outcome],
    });

    await list({ provider: "xai", agent: "work", json: false, plain: false });

    expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
      "Model discovery authentication was rejected for xai (profile xai:work). Open Models in the Control UI to check sign-in and catalog access, then retry with --refresh.",
    );
    expect(runtime.log).toHaveBeenCalledExactlyOnceWith("No models found.");
  });

  it("preserves model rows and public discovery facts without printing raw provider errors", async () => {
    const providerOutcomes = [
      { provider: "catalog-provider", status: "ready" },
      { provider: "\u001b[31mxai\u001b[0m", status: "auth-rejected", profileId: "work\nnext" },
      { provider: "offline", status: "unavailable" },
    ];
    vi.mocked(gateway.callGateway).mockResolvedValue({
      models: [model],
      refreshFailed: true,
      providerOutcomes: providerOutcomes.map((outcome) => ({
        ...outcome,
        message: "synthetic-private-provider-response",
      })),
    });

    await list({ json: true });

    expectModelRows([{ key: "catalog-provider/Reader", available: true }], {
      count: 1,
      providerOutcomes,
    });
    expect(runtime.writeJson).toHaveBeenCalledOnce();
    const warnings = [
      "Model discovery could not refresh all providers. Showing the available published model list.",
      "Model discovery authentication was rejected for xai (profile work\\nnext). Open Models in the Control UI to check sign-in and catalog access, then retry with --refresh.",
      "Model discovery is unavailable for offline. Retry with --refresh; if it still fails, check the provider in Models in the Control UI.",
    ];
    expect(runtime.error).toHaveBeenCalledTimes(warnings.length);
    for (const warning of warnings) {
      expect(runtime.error).toHaveBeenCalledWith(warning);
    }
    expect(JSON.stringify(runtime.error.mock.calls)).not.toContain("synthetic-private");
  });

  it.each([false, true])(
    "releases standalone refresh routing (discovery fails=%s)",
    async (fails) => {
      vi.mocked(gatewayLock.readActiveGatewayLockIdentity).mockResolvedValue(undefined);
      const handle = { proxyUrl: "http://proxy.example.test", stop: vi.fn(), kill: vi.fn() };
      vi.mocked(proxyLifecycle.startProxy).mockResolvedValue(handle);
      vi.mocked(catalog.withPreparedModelCatalogOwner).mockImplementation(async (_params, read) => {
        expect(proxyLifecycle.startProxy).toHaveBeenCalledTimes(1);
        expect(proxyLifecycle.stopProxy).not.toHaveBeenCalled();
        if (fails) {
          throw new Error("discovery failed");
        }
        return await read(createOwner());
      });
      const refresh = list({ agent: "work", all: true, json: true, refresh: true });
      if (fails) {
        await expect(refresh).rejects.toThrow("discovery failed");
      } else {
        await refresh;
        expectModelRows([{ key: "catalog-provider/Reader", contextWindow: 128000 }], { count: 1 });
      }
      expect(runtime.error).toHaveBeenCalledWith(
        "Gateway is not running. Refreshing the local model catalog.",
      );
      expect(gateway.callGateway).not.toHaveBeenCalled();
      expect(catalog.withPreparedModelCatalogOwner).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          agentId: "work",
          readOnly: false,
          refreshFullCatalog: true,
          persistOfflineRefresh: true,
        }),
        expect.any(Function),
      );
      expect(localStateOwner.runWithLocalStateOwner).toHaveBeenCalledWith(
        expect.objectContaining({ method: "models.list", onForeignOwner: "refuse" }),
      );
      expect(proxyLifecycle.startProxy).toHaveBeenCalledExactlyOnceWith(cfg.proxy);
      expect(proxyLifecycle.stopProxy).toHaveBeenCalledExactlyOnceWith(handle);
    },
  );

  it("lists a Claude CLI model once when only the standalone owner's registry has Claude CLI", async () => {
    const claudeCfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          work: {
            workspace: "/tmp/published-cli-work",
            models: { "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } } },
          },
        },
        defaults: { model: { primary: "anthropic/claude-opus-5" } },
      },
    };
    const entries = [
      { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
      { provider: "claude-cli", id: "claude-opus-5", name: "Claude Opus 5" },
      { provider: "claude-cli", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ];
    vi.mocked(configLoader.loadModelsConfigWithSource).mockResolvedValue({
      sourceConfig: claudeCfg,
      resolvedConfig: claudeCfg,
      diagnostics: [],
    });
    vi.mocked(gatewayLock.readActiveGatewayLockIdentity).mockResolvedValue(undefined);
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.cliBackends.push({
      pluginId: "anthropic",
      source: "test",
      backend: { id: "claude-cli", modelProvider: "anthropic", config: { command: "claude" } },
    });
    owner = createOwner({
      config: claudeCfg,
      observationConfig: claudeCfg,
      authModes: { "claude-cli": "oauth" },
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "anthropic",
            providers: ["anthropic"],
            cliBackends: ["claude-cli"],
            syntheticAuthRefs: ["claude-cli"],
            providerAuthAliases: { "claude-cli": "anthropic" },
          },
        ],
      }),
      modelCatalog: markPreparedModelCatalogFull({ entries, routeVariants: entries }),
      pluginRegistry,
    });
    await list({ agent: "work", json: true });
    expectModelRows([{ key: "anthropic/claude-opus-5" }, { key: "claude-cli/claude-haiku-4-5" }]);
    expect(runtime.writeJson).toHaveBeenCalledOnce();
  });

  it.each([
    [{ json: true, plain: true }, "Choose either --json or --plain"],
    [{ provider: "Example Provider", json: true }, "Invalid provider filter"],
  ] as const)("rejects invalid options %j before reading a catalog", async (options, error) => {
    await expect(list(options)).rejects.toThrow(error);
    expect(gateway.callGateway).not.toHaveBeenCalled();
    expect(catalog.withPreparedModelCatalogOwner).not.toHaveBeenCalled();
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
    expect(runtime.log).not.toHaveBeenCalled();
  });
});

describe("model list terminal table", () => {
  const makeModel = (provider: string, id: string): ModelChoice => ({
    provider,
    id,
    name: `${provider}/${id}`,
    input: ["text"],
    contextWindow: 128_000,
    local: false,
    available: true,
    tags: [],
  });
  it("prints context caps with sanitized tags in their original order", async () => {
    const tags = [
      "\u001b[31mdefault\u001b[0m",
      "fallback#2",
      "img-fallback#1",
      "alias:a\tb",
      "unknown",
      "default",
    ];
    const originalTags = [...tags];
    const rows: ModelChoice[] = [
      {
        ...makeModel("openai", "gpt-5.5"),
        input: ["text", "image"],
        contextWindow: 400_000,
        contextTokens: 272_000,
        tags,
      },
    ];

    vi.mocked(gateway.callGateway).mockResolvedValue({ models: rows });
    await list({});

    expect(runtime.log.mock.calls).toEqual([
      ["Model                                      Input      Ctx         Local Auth  Tags"],
      [
        "openai/gpt-5.5                             text+image 272k/400k   no    yes   default,fallback#2,img-fallback#1,alias:a\\tb,unknown,default",
      ],
    ]);
    expect(rows[0]?.tags).toEqual(originalTags);
  });

  it("keeps fixed-width rows aligned when model keys contain wide graphemes", async () => {
    const wideKey = `${"a".repeat(39)}表`;
    const rows = [makeModel("a", wideKey)];

    vi.mocked(gateway.callGateway).mockResolvedValue({ models: rows });
    await list({});

    const [header, row] = runtime.log.mock.calls.map(([line]) => line);
    expect(typeof header).toBe("string");
    expect(typeof row).toBe("string");
    const headerInputIndex = (header as string).indexOf("Input");
    const rowInputIndex = (row as string).indexOf("text");
    expect(headerInputIndex).toBeGreaterThan(0);
    expect(rowInputIndex).toBeGreaterThan(0);
    expect(visibleWidth((row as string).slice(0, rowInputIndex))).toBe(
      visibleWidth((header as string).slice(0, headerInputIndex)),
    );
  });
});
