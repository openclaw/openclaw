import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayClientRequestError } from "../../../packages/gateway-client/src/request-error.js";
import type { ModelChoice } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { visibleWidth } from "../../../packages/terminal-core/src/ansi.js";
import {
  createApiKeyCredential,
  createAuthProfileStoreFixture,
} from "../../agents/auth-profiles/credential-fixtures.test-support.js";
import * as catalog from "../../agents/prepared-model-catalog.js";
import { bindPreparedModelRuntimeAuth } from "../../agents/prepared-model-runtime-auth.js";
import { markPreparedModelCatalogFull } from "../../agents/prepared-model-runtime.full-catalog.js";
import type { PreparedModelRuntimeSnapshot } from "../../agents/prepared-model-runtime.types.js";
import { runCommandWithRuntime } from "../../cli/cli-utils.js";
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
import { printModelTable } from "./list.table.js";
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
    findConfiguredRuntimeModel: () => undefined,
    inlineProviderModels: [],
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
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(localStateOwner, "runWithLocalStateOwner").mockImplementation(async ({ runLocal }) =>
    runLocal({
      config: cfg,
      env: process.env,
      signal: new AbortController().signal,
      assertCurrent() {},
    }),
  );
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
  vi.spyOn(proxyLifecycle, "startProxy").mockResolvedValue(null);
  vi.spyOn(proxyLifecycle, "stopProxy").mockResolvedValue();
  vi.spyOn(catalog, "withPreparedModelCatalogOwner").mockImplementation(
    async (_params, read) => await read(createOwner()),
  );
});
afterEach(() => vi.restoreAllMocks());

async function list(options: Parameters<typeof modelsListCommand>[0]) {
  return withEnvAsync({ OPENCLAW_GATEWAY_PORT: undefined }, () =>
    modelsListCommand(options, runtime),
  );
}

describe("models list published transport", () => {
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

  it("uses a selected remote Gateway without reading a local lock owner", async () => {
    vi.mocked(gateway.isImplicitLocalGatewayTarget).mockResolvedValue(false);
    await list({ json: true });
    expect(gatewayLock.readActiveGatewayLockIdentity).not.toHaveBeenCalled();
    expect(catalog.withPreparedModelCatalogOwner).not.toHaveBeenCalled();
    expect(gateway.callGateway).toHaveBeenCalledExactlyOnceWith(
      expect.not.objectContaining({ localPortOverride: expect.anything() }),
    );
    expect(vi.mocked(gateway.callGateway).mock.calls[0]?.[0].timeoutMs).toBeUndefined();
  });

  it("prints an unknown provider rejection and exits unsuccessfully", async () => {
    const message =
      'Unknown model catalog provider "missing". Run openclaw models list --all to list models and their provider IDs.';
    vi.mocked(gateway.callGateway).mockRejectedValue(
      new GatewayClientRequestError({ code: "INVALID_REQUEST", message }),
    );

    await runCommandWithRuntime(runtime, () => list({ provider: "missing" }));

    expect(gateway.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "models.list",
        params: expect.objectContaining({ provider: "missing" }),
      }),
    );
    expect(runtime.error).toHaveBeenCalledExactlyOnceWith(message);
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(runtime.log).not.toHaveBeenCalled();
    expect(catalog.withPreparedModelCatalogOwner).not.toHaveBeenCalled();
  });

  it("treats an explicit Gateway port as a selected target even without a local lock", async () => {
    await withEnvAsync({ OPENCLAW_GATEWAY_PORT: "19002" }, () =>
      modelsListCommand({ json: true }, runtime),
    );
    expect(gatewayLock.readActiveGatewayLockIdentity).not.toHaveBeenCalled();
    expect(catalog.withPreparedModelCatalogOwner).not.toHaveBeenCalled();
    expect(gateway.callGateway).toHaveBeenCalledOnce();
  });

  it("keeps successful empty inventory empty", async () => {
    vi.mocked(gateway.callGateway).mockResolvedValue({ models: [] });
    await list({ json: true, refresh: true });
    expect(runtime.writeJson).toHaveBeenCalledWith({ count: 0, models: [] }, 2);
    expect(catalog.withPreparedModelCatalogOwner).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it.each([
    { refresh: true, refreshFailed: undefined },
    { refresh: false, refreshFailed: true },
  ])(
    "uses published refresh status with rejected auth for %j",
    async ({ refresh, refreshFailed }) => {
      vi.mocked(gateway.callGateway).mockResolvedValue({
        models: [model],
        refreshFailed,
        providerOutcomes: [{ provider: "signed-out", status: "auth-rejected" }],
      });
      await list({ refresh, json: true });
      expect(runtime.error).toHaveBeenCalledWith(
        "Model discovery authentication was rejected for signed-out. Open Models in the Control UI to check sign-in and catalog access, then retry with --refresh.",
      );
      if (refreshFailed) {
        expect(runtime.error).toHaveBeenCalledWith(
          "Model discovery could not refresh all providers. Showing the available published model list.",
        );
      } else {
        expect(runtime.error).toHaveBeenCalledTimes(1);
      }
      expect(runtime.writeJson).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }), 2);
      expect(gateway.callGateway).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          params: { view: "default", includeDetails: true, ...(refresh ? { refresh: true } : {}) },
        }),
      );
    },
  );

  it.each([
    { json: true, plain: false },
    { json: false, plain: true },
    { json: false, plain: false },
  ])("reports rejected discovery with empty provider inventory for %j", async (output) => {
    const outcome = { provider: "xai", profileId: "xai:work", status: "auth-rejected" };
    vi.mocked(gateway.callGateway).mockResolvedValue({
      models: [],
      providerOutcomes: [outcome],
    });

    await list({ provider: "xai", agent: "work", ...output });

    expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
      "Model discovery authentication was rejected for xai (profile xai:work). Open Models in the Control UI to check sign-in and catalog access, then retry with --refresh.",
    );
    if (output.json) {
      expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith(
        { count: 0, models: [], providerOutcomes: [outcome] },
        2,
      );
    } else if (output.plain) {
      expect(runtime.log).not.toHaveBeenCalled();
      expect(runtime.writeStdout).not.toHaveBeenCalled();
    } else {
      expect(runtime.log).toHaveBeenCalledExactlyOnceWith("No models found.");
    }
  });

  it("preserves model rows and public discovery facts without printing raw provider errors", async () => {
    const providerOutcomes = [
      { provider: "catalog-provider", status: "ready" },
      { provider: "xai", status: "auth-rejected", profileId: "xai:work" },
      { provider: "offline", status: "unavailable" },
    ];
    vi.mocked(gateway.callGateway).mockResolvedValue({
      models: [model],
      providerOutcomes: providerOutcomes.map((outcome) => ({
        ...outcome,
        message: "synthetic-private-provider-response",
      })),
    });

    await list({ json: true });

    expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        count: 1,
        models: [expect.objectContaining({ key: "catalog-provider/Reader", available: true })],
        providerOutcomes,
      }),
      2,
    );
    expect(runtime.error).toHaveBeenCalledTimes(2);
    expect(runtime.error).toHaveBeenCalledWith(
      "Model discovery is unavailable for offline. Retry with --refresh; if it still fails, check the provider in Models in the Control UI.",
    );
    expect(JSON.stringify(runtime.error.mock.calls)).not.toContain("synthetic-private");
  });

  it("sanitizes provider and profile labels in discovery warnings", async () => {
    vi.mocked(gateway.callGateway).mockResolvedValue({
      models: [model],
      providerOutcomes: [
        { provider: "\u001b[31mxai\u001b[0m", profileId: "work\nnext", status: "auth-rejected" },
      ],
    });

    await list({ plain: true });

    expect(runtime.error).toHaveBeenCalledExactlyOnceWith(
      "Model discovery authentication was rejected for xai (profile work\\nnext). Open Models in the Control UI to check sign-in and catalog access, then retry with --refresh.",
    );
    expect(runtime.writeStdout).toHaveBeenCalledExactlyOnceWith("catalog-provider/Reader");
  });

  it.each([false, true])(
    "uses the standalone owner only with no selected Gateway, refresh=%s",
    async (refresh) => {
      vi.mocked(gatewayLock.readActiveGatewayLockIdentity).mockResolvedValue(undefined);
      const stop = vi.fn(async () => {});
      const handle = { proxyUrl: "http://proxy.example.test", stop, kill: vi.fn() };
      vi.mocked(proxyLifecycle.startProxy).mockResolvedValue(handle);
      vi.mocked(catalog.withPreparedModelCatalogOwner).mockImplementation(async (_params, read) => {
        expect(proxyLifecycle.startProxy).toHaveBeenCalledTimes(refresh ? 1 : 0);
        expect(proxyLifecycle.stopProxy).not.toHaveBeenCalled();
        return await read(createOwner());
      });
      await list({ agent: "work", all: true, json: true, refresh });
      expect(runtime.error).toHaveBeenCalledWith(
        refresh
          ? "Gateway is not running. Refreshing the local model catalog."
          : "Gateway is not running. Showing the local cached model catalog. Use --refresh to discover provider models.",
      );
      expect(gateway.callGateway).not.toHaveBeenCalled();
      expect(catalog.withPreparedModelCatalogOwner).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          agentId: "work",
          readOnly: !refresh,
          ...(refresh ? { refreshFullCatalog: true, persistOfflineRefresh: true } : {}),
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
      if (refresh) {
        expect(localStateOwner.runWithLocalStateOwner).toHaveBeenCalledWith(
          expect.objectContaining({ method: "models.list", onForeignOwner: "refuse" }),
        );
        expect(proxyLifecycle.startProxy).toHaveBeenCalledExactlyOnceWith(cfg.proxy);
        expect(proxyLifecycle.stopProxy).toHaveBeenCalledExactlyOnceWith(handle);
      } else {
        expect(localStateOwner.runWithLocalStateOwner).not.toHaveBeenCalled();
        expect(proxyLifecycle.startProxy).not.toHaveBeenCalled();
      }
    },
  );

  it("releases local refresh proxy routing when discovery fails", async () => {
    vi.mocked(gatewayLock.readActiveGatewayLockIdentity).mockResolvedValue(undefined);
    const handle = { proxyUrl: "http://proxy.example.test", stop: vi.fn(), kill: vi.fn() };
    vi.mocked(proxyLifecycle.startProxy).mockResolvedValue(handle);
    vi.mocked(catalog.withPreparedModelCatalogOwner).mockRejectedValue(
      new Error("discovery failed"),
    );
    await expect(list({ refresh: true })).rejects.toThrow("discovery failed");
    expect(proxyLifecycle.stopProxy).toHaveBeenCalledExactlyOnceWith(handle);
  });

  // Only the standalone owner registers Claude CLI; the command process has no active registry.
  async function listStandaloneClaudeOwner(
    claudeCfg: OpenClawConfig,
    entries: Array<{ provider: string; id: string; name: string }>,
  ) {
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
    vi.mocked(catalog.withPreparedModelCatalogOwner).mockImplementation(
      async (_params, read) =>
        await read(
          createOwner({
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
          }),
        ),
    );
    await list({ agent: "work", json: true });
  }

  it("projects a standalone owner's Claude CLI route with that owner's plugin registry", async () => {
    await listStandaloneClaudeOwner(
      {
        agents: {
          ownership: "explicit",
          entries: { work: { workspace: "/tmp/published-cli-work" } },
          defaults: {
            model: { primary: "anthropic/claude-opus-5" },
            models: { "anthropic/claude-opus-5": { agentRuntime: { id: "claude-cli" } } },
          },
        },
      },
      [
        { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
        { provider: "claude-cli", id: "claude-opus-5", name: "Claude Opus 5" },
      ],
    );
    expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        models: [expect.objectContaining({ key: "anthropic/claude-opus-5", available: true })],
      }),
      2,
    );
  });

  it("lists a Claude CLI model once when only the standalone owner's registry has Claude CLI", async () => {
    await listStandaloneClaudeOwner(
      {
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
      },
      [
        { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
        { provider: "claude-cli", id: "claude-opus-5", name: "Claude Opus 5" },
        { provider: "claude-cli", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
      ],
    );
    expect(runtime.writeJson).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        models: [
          expect.objectContaining({ key: "anthropic/claude-opus-5" }),
          expect.objectContaining({ key: "claude-cli/claude-haiku-4-5" }),
        ],
      }),
      2,
    );
  });

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
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("keeps an empty plain list machine-readable", async () => {
    vi.mocked(gateway.callGateway).mockResolvedValue({ models: [] });
    await list({ plain: true });
    expect(runtime.writeStdout).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });
});

describe("model list terminal table", () => {
  const makeRow = (key: string): ModelRow => ({
    key,
    name: key,
    input: "text",
    contextWindow: 128_000,
    local: false,
    available: true,
    tags: [],
  });
  it("prints context caps with sanitized tags in their original order", () => {
    const tags = [
      "\u001b[31mdefault\u001b[0m",
      "fallback#2",
      "img-fallback#1",
      "alias:a\tb",
      "unknown",
      "default",
    ];
    const originalTags = [...tags];
    const rows = [
      {
        ...makeRow("openai/gpt-5.5"),
        input: "text+image",
        contextWindow: 400_000,
        contextTokens: 272_000,
        tags,
      },
    ];

    printModelTable(rows, runtime);

    expect(runtime.log.mock.calls).toEqual([
      ["Model                                      Input      Ctx         Local Auth  Tags"],
      [
        "openai/gpt-5.5                             text+image 272k/400k   no    yes   default,fallback#2,img-fallback#1,alias:a\\tb,unknown,default",
      ],
    ]);
    expect(rows[0]?.tags).toEqual(originalTags);
  });

  it("keeps fixed-width rows aligned when model keys contain wide graphemes", () => {
    const wideKey = `${"a".repeat(41)}表`;
    const rows = [makeRow(wideKey)];

    printModelTable(rows, runtime);

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
