import assert from "node:assert/strict";
import { Chalk } from "chalk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelChoice } from "../../../packages/gateway-protocol/src/schema/agents-models-skills.js";
import { stripAnsi, visibleWidth } from "../../../packages/terminal-core/src/ansi.js";
import * as terminalTheme from "../../../packages/terminal-core/src/theme.js";
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
function createOwner(): PreparedModelRuntimeSnapshot {
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
  vi.spyOn(configLoader, "loadModelsConfig").mockResolvedValue(cfg);
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

function gatewayModels(...models: ModelChoice[]) {
  vi.mocked(gateway.callGateway).mockResolvedValue({ models });
}

describe("models list published transport", () => {
  it.each(["ready", "unavailable"] as const)(
    "reports configured ids missing from a %s listing without changing availability",
    async (status) => {
      const outcome = {
        provider: model.provider,
        status,
        unlistedConfiguredModelIds: ["Reader", "Absent"],
      };
      vi.mocked(gateway.callGateway).mockResolvedValue({
        models: [model],
        providerOutcomes: [outcome],
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
        .flat()
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
    vi.mocked(configLoader.loadModelsConfig).mockRejectedValue(
      new Error("Local provider secret unavailable"),
    );
    gatewayModels(model, { provider: "catalog-provider", id: "reader", name: "Unknown route" });
    await list({ agent: "work", provider: "catalog-provider", json: true, refresh: true });
    expect(configLoader.loadModelsConfig).not.toHaveBeenCalled();
    expect(catalog.withPreparedModelCatalogOwner).not.toHaveBeenCalled();
    expect(proxyLifecycle.startProxy).not.toHaveBeenCalled();
    expect(localStateOwner.runWithLocalStateOwner).not.toHaveBeenCalled();
    expect(gateway.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        requiredCapabilities: ["published-model-catalog"],
        localPortOverride: 19001,
        params: expect.objectContaining({
          agentId: "work",
          provider: "catalog-provider",
          refresh: true,
        }),
      }),
    );
    expectModelRows(
      [
        {
          key: "catalog-provider/Reader",
          input: "text+image",
          available: true,
          tags: ["default", "alias:work"],
        },
        { key: "catalog-provider/reader", input: "-", local: null, available: null },
      ],
      { count: 2 },
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

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("rejected for xai (profile xai:work)"),
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
    expect(runtime.error.mock.calls.flat()).toEqual(
      expect.arrayContaining([
        expect.stringContaining("could not refresh all providers"),
        expect.stringContaining("rejected for xai (profile work\\nnext)"),
        expect.stringContaining("unavailable for offline"),
      ]),
    );
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
      expect(localStateOwner.runWithLocalStateOwner).toHaveBeenCalledWith(
        expect.objectContaining({ method: "models.list", onForeignOwner: "refuse" }),
      );
      expect(proxyLifecycle.startProxy).toHaveBeenCalledExactlyOnceWith(cfg.proxy);
      expect(proxyLifecycle.stopProxy).toHaveBeenCalledExactlyOnceWith(handle);
    },
  );

  it.each([
    [{ json: true, plain: true }, "Choose either --json or --plain"],
    [{ provider: "Example Provider", json: true }, "Invalid provider filter"],
  ] as const)("rejects invalid options %j before reading a catalog", async (options, error) => {
    await expect(list(options)).rejects.toThrow(error);
    expect(gateway.callGateway).not.toHaveBeenCalled();
    expect(catalog.withPreparedModelCatalogOwner).not.toHaveBeenCalled();
  });

  it("filters only proven local rows and renders their exact keys in plain output", async () => {
    gatewayModels(
      model,
      { ...model, id: "remote", local: false },
      { provider: "catalog-provider", id: "unknown", name: "Unknown" },
    );
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
  it("keeps fixed-width rows aligned when model keys contain wide graphemes", async () => {
    const wideKey = `${"a".repeat(39)}表`;
    gatewayModels(makeModel("a", wideKey));
    await list({});

    const [header, row] = runtime.log.mock.calls.map(([line]) => line);
    const headerInputIndex = (header as string).indexOf("Input");
    const rowInputIndex = (row as string).indexOf("text");
    expect(headerInputIndex).toBeGreaterThan(0);
    expect(rowInputIndex).toBeGreaterThan(0);
    expect(visibleWidth((row as string).slice(0, rowInputIndex))).toBe(
      visibleWidth((header as string).slice(0, headerInputIndex)),
    );
  });

  it.each([false, true])("renders sanitized tags and context caps (rich=%s)", async (rich) => {
    const color = new Chalk({ level: 1 });
    const roles = [
      ["success", color.green],
      ["accentBright", color.cyan],
      ["accent", color.blue],
      ["error", color.red],
      ["warn", color.yellow],
      ["accentDim", color.magenta],
      ["muted", color.gray],
    ] as const;
    vi.spyOn(terminalTheme, "isRich").mockReturnValue(rich);
    for (const [role, paint] of roles) {
      vi.spyOn(terminalTheme.theme, role).mockImplementation(paint);
    }
    const tagCases = [
      ["\u001b[31mdefault\u001b[0m", "default", color.green],
      ["image", "image", color.cyan],
      ["configured", "configured", color.blue],
      ["missing", "missing", color.red],
      ["fallback#2", "fallback#2", color.yellow],
      ["img-fallback#1", "img-fallback#1", color.yellow],
      ["alias:a\tb", "alias:a\\tb", color.magenta],
      ["unknown", "unknown", color.gray],
      ["default", "default", color.green],
    ] as const;
    const tags = tagCases.map(([raw]) => raw);
    const originalTags = [...tags];
    gatewayModels({
      ...makeModel("openai", "gpt-5.5"),
      input: ["text", "image"],
      contextWindow: 400_000,
      contextTokens: 272_000,
      tags,
    });
    await list({});
    const [header, row] = runtime.log.mock.calls.map(([line]) => line as string);
    assert(header !== undefined && row !== undefined);
    expect(stripAnsi(header)).toBe(
      "Model                                      Input      Ctx         Local Auth  Tags",
    );
    expect(
      row.endsWith(tagCases.map(([, clean, paint]) => (rich ? paint(clean) : clean)).join(",")),
    ).toBe(true);
    expect(stripAnsi(row)).toBe(
      `openai/gpt-5.5                             text+image 272k/400k   no    yes   ${tagCases.map(([, clean]) => clean).join(",")}`,
    );
    expect(tags).toEqual(originalTags);
  });
});
