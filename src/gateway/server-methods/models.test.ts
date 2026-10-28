// Models method tests cover published inventory, configured/all views,
// validation errors, and protocol response shapes.

import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getPreparedRuntimeAuthProfileStoreSnapshot,
  loadAuthProfileStoreWithoutExternalProfiles,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "../../agents/auth-profiles.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { configForProviders } from "../../agents/model-auth.fixtures.test-support.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { PreparedModelRuntimeAuth } from "../../agents/prepared-model-runtime-auth.js";
import { materializePreparedModelCatalog } from "../../agents/prepared-model-runtime.full-catalog.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { assertPluginMetadataSnapshotConsistency } from "../plugin-metadata.test-helpers.js";
import {
  type PreparedGatewayModelCatalogSnapshot,
  registerGatewayModelCatalogPrivateAccess,
} from "../server-model-catalog-auth.js";
import { WITHOUT_OPENAI_ENV_AUTH } from "../test-helpers.env.js";
import {
  claudeOptOutConfig,
  EXPECTED_DEMO_IDENTITY,
  EXPECTED_IMPLICIT_CODEX_RUNTIME,
  EXPECTED_IMPLICIT_OPENCLAW_RUNTIME,
  thinkingLevels,
} from "./models-runtime.fixtures.test-support.js";
import { modelsHandlers } from "./models.js";
import type { RespondFn } from "./types.js";

const FILE_SECRETS: NonNullable<OpenClawConfig["secrets"]> = {
  providers: {
    "mounted-json": {
      source: "file",
      path: "/tmp/openclaw-test-secrets.json",
      mode: "json",
    },
  },
};

const LLAMA_SECURE = { id: "llama-secure", name: "Llama Secure", provider: "vllm" };
const GPT_TEST = { id: "gpt-test", name: "GPT Test", provider: "openai" };
const GPT_CODEX = { id: "gpt-5.4", name: "GPT-5.4 Codex", provider: "openai" };
const VLLM_KEY_REF = {
  source: "file",
  provider: "mounted-json",
  id: "/providers/vllm/apiKey",
} as const;

const modelPluginMetadataSnapshot = await vi.hoisted(async () => {
  const { createModelPluginMetadataSnapshot } = await import("./models-metadata.test-support.js");
  return createModelPluginMetadataSnapshot();
});

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => modelPluginMetadataSnapshot,
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: () => modelPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot: () => modelPluginMetadataSnapshot,
}));

vi.mock("../../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: (params: { provider: string; context: { modelId: string } }) => {
    if (params.provider !== "claude-cli") {
      return undefined;
    }
    if (params.context.modelId === "claude-mythos-5") {
      return { levels: [{ id: "off" }], defaultLevel: "off" };
    }
    if (params.context.modelId === "claude-fable-5") {
      return {
        levels: [
          { id: "minimal" },
          { id: "low" },
          { id: "medium" },
          { id: "high" },
          { id: "xhigh" },
          { id: "adaptive" },
          { id: "max" },
        ],
        defaultLevel: "high",
        preserveWhenCatalogReasoningFalse: true,
      };
    }
    return undefined;
  },
}));

const withoutOpenAIEnvAuth = async <T>(run: () => Promise<T>): Promise<T> =>
  await withEnvAsync({ ...WITHOUT_OPENAI_ENV_AUTH }, run);

const withoutAnthropicEnvAuth = async <T>(run: () => Promise<T>): Promise<T> =>
  await withEnvAsync(
    {
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_AUTH_TOKEN: undefined,
      CLAUDE_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      HOME: modelsTestState.home,
    },
    run,
  );

let modelsTestState: OpenClawTestState;

beforeAll(async () => {
  assertPluginMetadataSnapshotConsistency(modelPluginMetadataSnapshot as PluginMetadataSnapshot);
  modelsTestState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-models-list-",
    agentEnv: "main",
  });
});

afterAll(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  await modelsTestState.cleanup();
});

async function withModelsTestState<T>(
  options: { env?: Record<string, string | undefined> },
  run: (state: OpenClawTestState) => Promise<T>,
): Promise<T> {
  clearRuntimeAuthProfileStoreSnapshots();
  await modelsTestState.writeAuthProfiles({ version: 1, profiles: {} });
  try {
    return await withEnvAsync(options.env ?? {}, () => run(modelsTestState));
  } finally {
    clearRuntimeAuthProfileStoreSnapshots();
  }
}

function createDemoOAuthStore(params: { access: string; expires: number }) {
  return {
    version: 1 as const,
    profiles: {
      "demo-provider:oauth": {
        type: "oauth" as const,
        provider: "demo-provider",
        access: params.access,
        refresh: "refresh-token",
        expires: params.expires,
      },
    },
  };
}

function catalogLoader(entries: Array<Record<string, unknown>>) {
  return vi.fn(async () => entries);
}

function requestModelsList(params: {
  view: "default" | "configured" | "provider-config" | "all";
  agentId?: string;
  runtimeConfig?: OpenClawConfig;
  loadGatewayModelCatalog: (params?: {
    agentId?: string;
    agentDir?: string;
    readOnly?: boolean;
    workspaceDir?: string;
  }) => Promise<Array<Record<string, unknown>>>;
  reqId?: string;
  includeDefaultModels?: boolean;
  includeProviderCapabilities?: boolean;
  deferredAuth?: Promise<PreparedModelRuntimeAuth>;
  refresh?: boolean;
  publishedCatalog?: ModelCatalogEntry[];
  catalogComplete?: boolean;
  preparedAuthModes?: PreparedModelRuntimeAuth["authModes"];
}) {
  const respond = vi.fn();
  const runtimeConfig = params.runtimeConfig ?? {};
  const getRuntimeConfig = () => runtimeConfig;
  const resolveOwnerFacts = () => {
    const config = getRuntimeConfig();
    const agentId = params.agentId ?? resolveDefaultAgentId(config);
    const agentDir = resolveAgentDir(config, agentId);
    return {
      agentId,
      agentDir,
      workspaceDir: agentDir,
      config,
      observationConfig: config,
      isCurrent: () => getRuntimeConfig() === config,
      authModes: params.preparedAuthModes ?? {},
      authStore:
        getPreparedRuntimeAuthProfileStoreSnapshot(agentDir) ??
        loadAuthProfileStoreWithoutExternalProfiles(agentDir, { allowKeychainPrompt: false }),
      metadataSnapshot: loadManifestMetadataSnapshot({ config, env: process.env }),
    };
  };
  const loadSnapshot = async (loadParams: Parameters<typeof params.loadGatewayModelCatalog>[0]) => {
    const entries = await params.loadGatewayModelCatalog(loadParams);
    const owner = resolveOwnerFacts();
    return {
      ...owner,
      ...(loadParams?.agentId ? { agentId: loadParams.agentId } : {}),
      catalogComplete: params.catalogComplete ?? loadParams?.readOnly === false,
      entries,
      routeVariants: entries,
      authMaterializations: [],
    } as unknown as PreparedGatewayModelCatalogSnapshot;
  };
  const loadGatewayModelCatalogSnapshot = async (
    loadParams: Parameters<typeof params.loadGatewayModelCatalog>[0],
  ) => loadSnapshot(loadParams);
  let published: PreparedGatewayModelCatalogSnapshot | undefined;
  registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
    loadDeferred: async (loadParams) => {
      const snapshot = await loadSnapshot(loadParams);
      published = snapshot;
      if (!params.deferredAuth) {
        return snapshot;
      }
      published = { ...snapshot, ...(await params.deferredAuth) };
      return published;
    },
    readPrepared: async () => {
      if (published && published.config === getRuntimeConfig()) {
        return published;
      }
      published = params.publishedCatalog
        ? {
            ...resolveOwnerFacts(),
            catalogComplete: false,
            entries: params.publishedCatalog,
            routeVariants: params.publishedCatalog,
            authMaterializations: [],
          }
        : await loadSnapshot({ agentId: params.agentId, readOnly: true });
      return published;
    },
  });
  const requestParams = {
    view: params.view,
    ...(params.includeDefaultModels === undefined
      ? {}
      : { includeDefaultModels: params.includeDefaultModels }),
    ...(params.refresh ? { refresh: true } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.includeProviderCapabilities ? { includeProviderCapabilities: true } : {}),
  };
  const request = expectDefined(
    modelsHandlers["models.list"],
    'modelsHandlers["models.list"] test invariant',
  )({
    req: {
      type: "req",
      id: params.reqId ?? `req-models-list-${params.view}`,
      method: "models.list",
      params: requestParams,
    },
    params: requestParams,
    respond: respond as RespondFn,
    client: null,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig,
      loadGatewayModelCatalog: params.loadGatewayModelCatalog,
      loadGatewayModelCatalogSnapshot,
      logGateway: {
        debug: vi.fn(),
        warn: vi.fn(),
      },
    } as never,
  });
  return { request, respond };
}

async function listModels(params: Parameters<typeof requestModelsList>[0]) {
  const { request, respond } = requestModelsList(params);
  await request;
  return respond;
}

function expectModels(respond: ReturnType<typeof vi.fn>, models: unknown) {
  expect(respond).toHaveBeenCalledWith(true, { models }, undefined);
}

async function expectModelsList(params: Parameters<typeof requestModelsList>[0], models: unknown) {
  const respond = await listModels(params);
  expectModels(respond, models);
  return respond;
}

function modelPayload(respond: ReturnType<typeof vi.fn>) {
  return respond.mock.calls[0]?.[1] as { models: Array<Record<string, unknown>> };
}

async function expectDemoAvailability(available: boolean, runtimeConfig?: OpenClawConfig) {
  await expectModelsList(
    {
      view: "all",
      runtimeConfig,
      loadGatewayModelCatalog: catalogLoader([EXPECTED_DEMO_IDENTITY]),
    },
    [{ ...EXPECTED_DEMO_IDENTITY, available }],
  );
}

describe("models.list", () => {
  it.each(["claude-fable-5-1", "Claude Gateway/claude-fable-5-1"])(
    "publishes the native Fable effort ladder for %s on a custom Messages provider",
    async (id) => {
      const respond = await listModels({
        view: "all",
        loadGatewayModelCatalog: vi.fn(async () => [
          {
            id,
            name: "Pooled Fable",
            provider: "proxy",
            api: "anthropic-messages",
            reasoning: true,
          },
        ]),
      });

      expect(respond.mock.calls[0]?.[1]).toMatchObject({
        models: [
          {
            id,
            provider: "proxy",
            thinkingLevels: ["low", "medium", "high", "xhigh", "max", "ultra"].map((level) => ({
              id: level,
              label: level,
            })),
            thinkingDefault: "medium",
          },
        ],
      });
    },
  );

  it("loads the requested agent catalog", async () => {
    const loadGatewayModelCatalog = catalogLoader([
      { id: "writer-model", name: "Writer Model", provider: "test" },
    ]);
    const { request } = requestModelsList({
      view: "configured",
      agentId: "writer",
      runtimeConfig: {
        agents: {
          entries: {
            main: {},
            writer: { model: "test/writer-model" },
          },
        },
      },
      loadGatewayModelCatalog,
    });

    await request;

    expect(loadGatewayModelCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "writer" }),
    );
  });

  it("returns typed selection-required until an explicit fleet selects an agent", async () => {
    const runtimeConfig = {
      agents: {
        ownership: "explicit" as const,
        entries: { ops: {}, research: {} },
      },
    };
    const missing = requestModelsList({
      view: "configured",
      runtimeConfig,
      loadGatewayModelCatalog: catalogLoader([]),
    });
    await missing.request;
    expect(missing.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("agent"),
      }),
    );

    const selected = requestModelsList({
      view: "configured",
      includeDefaultModels: false,
      agentId: "research",
      runtimeConfig,
      loadGatewayModelCatalog: catalogLoader([]),
    });
    await selected.request;
    expect(selected.respond).toHaveBeenCalledWith(true, { models: [] }, undefined);
  });

  it("reports API-key capability from provider auth contracts when requested", async () => {
    const respond = await expectModelsList(
      {
        view: "all",
        includeProviderCapabilities: true,
        loadGatewayModelCatalog: catalogLoader([
          { id: "claude-test", name: "Claude Test", provider: "anthropic" },
          { id: "copilot-test", name: "Copilot Test", provider: "github-copilot" },
          { id: "byteplus-test", name: "BytePlus Plan Test", provider: "byteplus-plan" },
          { id: "custom-test", name: "Custom Test", provider: "custom-cloud" },
        ]),
      },
      expect.arrayContaining([
        expect.objectContaining({ provider: "anthropic", apiKeySupported: true }),
        expect.objectContaining({ provider: "github-copilot", apiKeySupported: false }),
        expect.objectContaining({ provider: "byteplus-plan", apiKeySupported: true }),
      ]),
    );
    const payload = respond.mock.calls[0]?.[1] as
      | { models: Array<{ provider: string; apiKeySupported?: boolean }> }
      | undefined;
    const custom = payload?.models.find((model) => model.provider === "custom-cloud");
    expect(custom).toBeDefined();
    expect(custom).not.toHaveProperty("apiKeySupported");
  });

  it("projects exact CLI runtime thinking capabilities onto every configured Claude model", async () => {
    const modelIds = [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-5",
      "claude-fable-5",
      "claude-sonnet-4-6",
    ];
    const runtimeConfig: OpenClawConfig = {
      agents: {
        defaults: {
          models: Object.fromEntries(
            modelIds.map((modelId) => [
              `anthropic/${modelId}`,
              { agentRuntime: { id: "claude-cli" } },
            ]),
          ),
        },
      },
    };
    const loadGatewayModelCatalog = vi.fn(async () =>
      modelIds.map((modelId) => ({
        id: modelId,
        name: modelId,
        provider: "anthropic",
        reasoning: true,
      })),
    );
    const respond = await listModels({
      view: "all",
      runtimeConfig,
      loadGatewayModelCatalog,
    });

    const payload = modelPayload(respond);
    for (const modelId of modelIds) {
      expect(
        payload?.models.find((entry) => entry.provider === "anthropic" && entry.id === modelId),
      ).toMatchObject({
        reasoning: true,
        agentRuntime: { id: "claude-cli" },
        thinkingLevels: thinkingLevels("off minimal low medium high ultra"),
      });
    }
  });

  it("preserves a configured reasoning opt-out on a Claude CLI route", async () => {
    const modelId = "claude-opus-5";
    const runtimeConfig = claudeOptOutConfig(modelId);
    const loadGatewayModelCatalog = catalogLoader([
      { id: modelId, name: modelId, provider: "anthropic", reasoning: false },
      {
        id: modelId,
        name: `${modelId} (Claude CLI)`,
        provider: "claude-cli",
        reasoning: true,
      },
    ]);
    const respond = await listModels({
      view: "all",
      runtimeConfig,
      loadGatewayModelCatalog,
    });

    const payload = modelPayload(respond);
    expect(
      payload?.models.find((entry) => entry.provider === "anthropic" && entry.id === modelId),
    ).toMatchObject({
      reasoning: false,
      agentRuntime: { id: "claude-cli" },
      thinkingLevels: thinkingLevels("off ultra"),
    });
  });

  it("preserves mandatory Claude CLI thinking despite a configured reasoning opt-out", async () => {
    const modelId = "claude-fable-5";
    const runtimeConfig = claudeOptOutConfig(modelId);
    const materializedCatalog = materializePreparedModelCatalog(
      {
        entries: [{ id: modelId, name: modelId, provider: "anthropic", reasoning: false }],
        routeVariants: [],
      },
      [
        {
          provider: "anthropic",
          modelId,
          model: {
            id: modelId,
            name: `${modelId} (Claude CLI)`,
            provider: "claude-cli",
            reasoning: true,
          } as never,
        },
      ],
    ).entries;
    const respond = await listModels({
      view: "configured",
      runtimeConfig,
      loadGatewayModelCatalog: catalogLoader(materializedCatalog),
    });

    const payload = modelPayload(respond);
    expect(
      payload?.models.find((entry) => entry.provider === "anthropic" && entry.id === modelId),
    ).toMatchObject({
      reasoning: false,
      agentRuntime: { id: "claude-cli" },
      thinkingLevels: thinkingLevels("minimal low medium adaptive high xhigh max ultra"),
      thinkingDefault: "high",
    });
  });

  it("publishes a materialized Claude CLI logical row with its configured thinking default", async () => {
    const modelIds = ["claude-opus-5", "claude-sonnet-5"];
    const runtimeConfig = {
      agents: {
        defaults: {
          model: { primary: `anthropic/${modelIds[0]}` },
          models: Object.fromEntries(
            modelIds.map((modelId) => [
              `anthropic/${modelId}`,
              { agentRuntime: { id: "claude-cli" }, params: { thinking: "medium" } },
            ]),
          ),
        },
      },
      models: configForProviders({
        anthropic: { models: modelIds.map((id) => ({ id, name: id })) },
      }).models,
    } as unknown as OpenClawConfig;
    const respond = await listModels({
      view: "configured",
      runtimeConfig,
      // Prepared catalog shape: runtime-only rows are deliberately absent.
      loadGatewayModelCatalog: vi.fn(async () =>
        modelIds.map((id) => ({ id, name: id, provider: "anthropic", reasoning: true })),
      ),
    });

    const payload = modelPayload(respond);
    for (const modelId of modelIds) {
      expect(
        payload?.models.find((entry) => entry.provider === "anthropic" && entry.id === modelId),
      ).toMatchObject({
        reasoning: true,
        agentRuntime: { id: "claude-cli" },
        thinkingDefault: "medium",
        thinkingLevels: expect.arrayContaining([
          { id: "off", label: "off" },
          { id: "medium", label: "medium" },
          { id: "high", label: "high" },
        ]),
      });
    }
  });

  it("publishes the concrete Claude CLI thinking policy for a configured logical model", async () => {
    const modelId = "claude-mythos-5";
    const runtimeConfig = {
      agents: {
        defaults: {
          model: { primary: `anthropic/${modelId}` },
          models: {
            [`anthropic/${modelId}`]: { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
      models: configForProviders({
        anthropic: { models: [{ id: modelId, name: "Claude Mythos 5" }] },
      }).models,
    } as unknown as OpenClawConfig;
    const materializedCatalog = materializePreparedModelCatalog(
      {
        entries: [{ id: modelId, name: "Claude Mythos 5", provider: "anthropic" }],
        routeVariants: [],
      },
      [
        {
          provider: "anthropic",
          modelId,
          model: {
            id: modelId,
            name: "Claude Mythos 5 (Claude CLI)",
            provider: "claude-cli",
            reasoning: true,
          } as never,
        },
      ],
    ).entries;
    const respond = await listModels({
      view: "configured",
      runtimeConfig,
      loadGatewayModelCatalog: catalogLoader(materializedCatalog),
    });

    const payload = modelPayload(respond);
    const model = payload?.models.find(
      (entry) => entry.provider === "anthropic" && entry.id === modelId,
    );
    expect(model).toMatchObject({
      provider: "anthropic",
      reasoning: true,
      agentRuntime: { id: "claude-cli" },
      thinkingLevels: thinkingLevels("off ultra"),
      thinkingDefault: "off",
    });
    expect(model).not.toHaveProperty("thinkingPolicyProvider");
  });

  it("keeps source-authored provider inventory when the canonical catalog is missing", async () => {
    const sourceProvider = {
      baseUrl: "https://vllm.example/v1",
      apiKey: VLLM_KEY_REF,
      models: [
        {
          id: "source-model",
          name: "Source Model",
          contextWindow: 128_000,
          reasoning: true,
          input: ["text", "image"],
          params: { temperature: 0.2 },
          compat: { supportsDeveloperRole: false },
        },
      ],
    };
    const sourceConfig = {
      agents: {
        defaults: {
          models: {
            "vllm/allowlisted": {},
          },
        },
      },
      secrets: FILE_SECRETS,
      models: {
        providers: {
          vllm: sourceProvider,
        },
      },
    } as unknown as OpenClawConfig;
    const runtimeConfig = {
      ...sourceConfig,
      models: {
        providers: {
          vllm: {
            ...sourceProvider,
            apiKey: "test-key",
            models: [{ id: "runtime-only", name: "Runtime Only" }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const loadGatewayModelCatalog = catalogLoader([
      {
        id: "source-model",
        name: "Source Model",
        provider: "vllm",
        status: "disabled",
        contextWindow: 128_000,
        reasoning: true,
        input: ["text", "image"],
      },
    ]);
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    try {
      await expectModelsList(
        {
          view: "provider-config",
          runtimeConfig,
          loadGatewayModelCatalog,
        },
        [
          {
            id: "source-model",
            name: "Source Model",
            provider: "vllm",
            contextWindow: 128_000,
            reasoning: true,
            input: ["text", "image"],
            available: true,
            thinkingLevels: thinkingLevels("off minimal low medium high ultra"),
            thinkingDefault: "medium",
          },
        ],
      );
      expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
      expect(loadGatewayModelCatalog).toHaveBeenCalledWith(
        expect.objectContaining({ readOnly: true }),
      );
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("omits unknown provider-config availability", async () => {
    const config = {
      secrets: FILE_SECRETS,
      models: {
        providers: {
          vllm: {
            baseUrl: "https://vllm.example/v1",
            apiKey: VLLM_KEY_REF,
            models: [
              {
                id: "llama-secure",
                name: "Llama Secure",
                input: ["text", "image", "document"],
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;
    setRuntimeConfigSnapshot(config, config);
    try {
      await expectModelsList(
        {
          view: "provider-config",
          runtimeConfig: config,
          loadGatewayModelCatalog: catalogLoader([]),
        },
        [
          {
            ...LLAMA_SECURE,
            local: false,
            input: ["text", "image", "document"],
            tags: ["default"],
          },
        ],
      );
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it.each(["provider discovery", "deferred auth"])(
    "reads configured rows without awaiting %s",
    async (pending) => {
      await withoutOpenAIEnvAuth(async () => {
        const catalog = createDeferred<never>();
        const auth = createDeferred<PreparedModelRuntimeAuth>();
        const loadGatewayModelCatalog =
          pending === "provider discovery"
            ? vi.fn(() => catalog.promise)
            : catalogLoader([GPT_TEST]);
        const runtimeConfig = configForProviders({
          openai: {
            baseUrl: "https://openai.example.com",
            models: [{ id: "gpt-test", name: "GPT Test" }],
          },
        }) as unknown as OpenClawConfig;
        await expectModelsList(
          {
            publishedCatalog: [],
            view: "configured",
            includeDefaultModels: false,
            runtimeConfig,
            loadGatewayModelCatalog,
            ...(pending === "deferred auth" ? { deferredAuth: auth.promise } : {}),
          },
          [
            {
              ...GPT_TEST,
              agentRuntime: EXPECTED_IMPLICIT_OPENCLAW_RUNTIME,
              local: false,
              available: false,
              unavailableReason: "missing-auth",
              tags: ["default"],
            },
          ],
        );
        if (pending === "provider discovery") {
          expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
        }
      });
    },
  );

  it("does not advertise a subscription route after deferred auth observes logout", async () => {
    await withoutOpenAIEnvAuth(async () => {
      const runtimeConfig = configForProviders({
        openai: {
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          models: [{ id: "gpt-5.4", name: "GPT-5.4" }],
        },
      }) as unknown as OpenClawConfig;
      await expectModelsList(
        {
          refresh: true,
          view: "configured",
          includeDefaultModels: false,
          runtimeConfig,
          preparedAuthModes: { openai: "oauth" },
          deferredAuth: Promise.resolve({
            authStore: { version: 1, profiles: {} },
            authModes: {},
          }),
          loadGatewayModelCatalog: catalogLoader([
            {
              id: "gpt-5.4",
              name: "GPT-5.4",
              provider: "openai",
              api: "openai-chatgpt-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
            },
          ]),
        },
        [expect.objectContaining({ id: "gpt-5.4", provider: "openai", available: false })],
      );
    });
  });

  it("reads wildcard provider inventory without discovery", async () => {
    const catalog = createDeferred<never>();
    const loadGatewayModelCatalog = vi.fn(() => catalog.promise);
    const runtimeConfig = {
      agents: {
        defaults: {
          modelPolicy: { allow: ["vllm/*"] },
        },
      },
      models: configForProviders({
        vllm: {
          baseUrl: "https://vllm.example/v1",
          models: [{ id: "llama-local", name: "Llama Local" }],
        },
      }).models,
    } as unknown as OpenClawConfig;
    await expectModelsList(
      {
        publishedCatalog: [],
        view: "provider-config",
        runtimeConfig,
        loadGatewayModelCatalog,
      },
      [
        {
          id: "llama-local",
          name: "Llama Local",
          provider: "vllm",
          local: false,
          tags: ["default"],
        },
      ],
    );
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
  });

  it("keeps SecretRef configured rows unavailable without acquiring auth", async () => {
    const catalog = createDeferred<never>();
    const loadGatewayModelCatalog = vi.fn(() => catalog.promise);
    const runtimeConfig = {
      secrets: FILE_SECRETS,
      models: configForProviders({
        vllm: {
          baseUrl: "https://vllm.example/v1",
          apiKey: VLLM_KEY_REF,
          models: [{ id: "llama-secure", name: "Llama Secure" }],
        },
      }).models,
    } as unknown as OpenClawConfig;
    await expectModelsList(
      {
        publishedCatalog: [],
        view: "configured",
        includeDefaultModels: false,
        runtimeConfig,
        loadGatewayModelCatalog,
      },
      [{ ...LLAMA_SECURE, local: false, available: false, tags: ["default"] }],
    );
  });

  it("keeps the published all view exact while projection settles", async () => {
    await withoutOpenAIEnvAuth(async () => {
      const catalog = createDeferred<[{ id: string; name: string; provider: string }]>();
      const loadGatewayModelCatalog = vi.fn(() => catalog.promise);

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const { request, respond } = requestModelsList({
          view: "all",
          loadGatewayModelCatalog,
        });

        await vi.advanceTimersByTimeAsync(800);
        expect(respond).not.toHaveBeenCalled();

        catalog.resolve([GPT_TEST]);
        await request;

        expectModels(respond, [
          {
            ...GPT_TEST,
            agentRuntime: EXPECTED_IMPLICIT_CODEX_RUNTIME,
            available: false,
            cyberAccessProgramDefault: "standard",
          },
        ]);
        expect(loadGatewayModelCatalog).toHaveBeenCalledWith(
          expect.objectContaining({ readOnly: true }),
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("filters provider-scoped configured views from the published catalog", async () => {
    await withoutOpenAIEnvAuth(async () => {
      const catalog = [
        { id: "claude-test", name: "Claude Test", provider: "anthropic" },
        { id: "gpt-5.4-codex", name: "GPT-5.4 Codex", provider: "openai" },
        { id: "gpt-codex-test", name: "GPT Codex Test", provider: "openai" },
        { id: "llama-local", name: "Llama Local", provider: "vllm" },
        { id: "qwen-local", name: "Qwen Local", provider: "vllm" },
      ];
      const cfg = {
        agents: {
          defaults: {
            models: {
              "openai/*": {},
              "vllm/*": {},
            },
          },
        },
        models: configForProviders({
          openai: {
            api: "openai-responses",
            apiKey: "test-key",
            baseUrl: "https://api.openai.com/v1",
          },
          vllm: { apiKey: "test-key" },
        }).models,
      } as unknown as OpenClawConfig;

      const configuredModels = [
        {
          ...GPT_CODEX,
          agentRuntime: EXPECTED_IMPLICIT_CODEX_RUNTIME,
          cyberAccessProgramDefault: "standard",
          local: false,
          available: true,
        },
        {
          id: "gpt-codex-test",
          name: "GPT Codex Test",
          provider: "openai",
          agentRuntime: EXPECTED_IMPLICIT_CODEX_RUNTIME,
          cyberAccessProgramDefault: "standard",
          local: false,
          available: true,
        },
        { id: "llama-local", name: "Llama Local", provider: "vllm", available: true },
        { id: "qwen-local", name: "Qwen Local", provider: "vllm", available: true },
      ];
      const loadConfiguredCatalog = catalogLoader(catalog);
      await expectModelsList(
        {
          view: "configured",
          includeDefaultModels: false,
          runtimeConfig: cfg,
          loadGatewayModelCatalog: loadConfiguredCatalog,
        },
        configuredModels,
      );
      expect(loadConfiguredCatalog).toHaveBeenCalledWith(
        expect.objectContaining({ readOnly: true }),
      );

      await expectModelsList(
        {
          view: "all",
          runtimeConfig: cfg,
          loadGatewayModelCatalog: catalogLoader(catalog),
        },
        [
          {
            id: "claude-test",
            name: "Claude Test",
            provider: "anthropic",
            available: false,
            unavailableReason: "missing-auth",
          },
          ...configuredModels,
        ],
      );
    });
  });

  it("keeps keyless local provider wildcard discoveries visible with unknown availability", async () => {
    await withoutOpenAIEnvAuth(async () => {
      await withModelsTestState(
        {
          env: { VLLM_API_KEY: undefined },
        },
        async () => {
          const catalog = [
            {
              id: "llama-configured",
              name: "Llama Configured",
              provider: "vllm",
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8000/v1",
            },
            {
              id: "llama-discovered",
              name: "Llama Discovered",
              provider: "vllm",
              api: "openai-completions",
              baseUrl: "http://127.0.0.1:8000/v1",
            },
          ];
          const cfg = {
            agents: { defaults: { models: { "vllm/*": {} } } },
            models: configForProviders({
              vllm: {
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:8000/v1",
                models: [{ id: "llama-configured", name: "Llama Configured" }],
              },
            }).models,
          } as unknown as OpenClawConfig;
          const expected = {
            models: [
              {
                id: "llama-configured",
                name: "Llama Configured",
                provider: "vllm",
                local: true,
                available: true,
                tags: ["default"],
              },
              {
                id: "llama-discovered",
                name: "Llama Discovered",
                provider: "vllm",
                local: true,
                available: true,
              },
            ],
          };

          for (const view of ["default", "configured"] as const) {
            const { request, respond } = requestModelsList({
              view,
              includeDefaultModels: false,
              runtimeConfig: cfg,
              loadGatewayModelCatalog: catalogLoader(catalog),
            });
            await request;
            expect(respond).toHaveBeenCalledWith(true, expected, undefined);
          }
        },
      );
    });
  });

  it("marks legacy OpenAI Codex aliases available through ChatGPT OAuth", async () => {
    await withoutOpenAIEnvAuth(async () => {
      await withModelsTestState({}, async (state) => {
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "openai:chatgpt": {
              type: "oauth",
              provider: "openai",
              access: "chatgpt-access",
              refresh: "chatgpt-refresh",
              expires: Date.now() + 30 * 60_000,
            },
          },
        });

        await expectModelsList(
          {
            view: "all",
            loadGatewayModelCatalog: catalogLoader([
              {
                id: "gpt-5.4-codex",
                name: "GPT-5.4 Codex",
                provider: "openai",
                api: "openai-responses",
                baseUrl: "https://api.openai.com/v1",
              },
            ]),
          },
          [
            {
              ...GPT_CODEX,
              agentRuntime: EXPECTED_IMPLICIT_CODEX_RUNTIME,
              cyberAccessProgramDefault: "standard",
              local: false,
              available: true,
            },
          ],
        );
      });
    });
  });

  it.each([
    { authenticated: true, available: true, catalogComplete: false },
    { authenticated: false, available: false, catalogComplete: false },
    { authenticated: false, available: false, catalogComplete: true },
  ])(
    "projects native Claude runtime availability when authenticated=$authenticated, complete=$catalogComplete",
    async ({ authenticated, available, catalogComplete }) => {
      await withoutAnthropicEnvAuth(async () => {
        await withModelsTestState({}, async () => {
          cliBackendsTesting.setDepsForTest({
            resolveRuntimeCliBackends: () =>
              [{ id: "claude-cli", modelProvider: "anthropic", pluginId: "anthropic" }] as never,
          });
          try {
            const runtimeConfig = {
              agents: {
                defaults: {
                  models: {
                    "anthropic/claude-opus-4-8": {
                      agentRuntime: { id: "claude-cli" },
                    },
                  },
                },
              },
            } as unknown as OpenClawConfig;
            await expectModelsList(
              {
                view: "all",
                runtimeConfig,
                catalogComplete,
                preparedAuthModes: authenticated ? { "claude-cli": "api_key" } : {},
                loadGatewayModelCatalog: catalogLoader([
                  {
                    id: "claude-opus-4-8",
                    name: "Claude Opus 4.8",
                    provider: "anthropic",
                  },
                ]),
              },
              [
                {
                  id: "claude-opus-4-8",
                  name: "Claude Opus 4.8",
                  provider: "anthropic",
                  agentRuntime: {
                    id: "claude-cli",
                    cloudPlacementSupported: false,
                    devicePlacementSupported: false,
                    source: "model",
                  },
                  available,
                  tags: ["configured"],
                  ...(authenticated ? {} : { unavailableReason: "missing-auth" }),
                },
              ],
            );
          } finally {
            cliBackendsTesting.resetDepsForTest();
          }
        });
      });
    },
  );

  it.each([
    { name: "file SecretRef", model: LLAMA_SECURE, apiKey: VLLM_KEY_REF, secrets: FILE_SECRETS },
    {
      name: "managed SecretRef",
      model: { id: "llama-managed", name: "Llama Managed", provider: "vllm" },
      apiKey: "secretref-managed",
    },
  ])(
    "keeps $name provider availability unknown without runtime proof",
    async ({ model, apiKey, secrets }) => {
      await expectModelsList(
        {
          view: "all",
          runtimeConfig: {
            ...(secrets ? { secrets } : {}),
            agents: { defaults: { models: { "vllm/*": {} } } },
            models: configForProviders({ vllm: { apiKey } }).models,
          } as unknown as OpenClawConfig,
          loadGatewayModelCatalog: catalogLoader([model]),
        },
        [{ ...model, available: false }],
      );
    },
  );

  it.each([
    "resolved-runtime-key",
    "ollama-local",
    "custom-local",
    "OPENAI_API_KEY",
    "secretref-managed",
    "secretref-env:UNRELATED_KEY",
    "${UNRELATED_KEY}",
    "$malformed-template",
  ])("uses an exact hydrated runtime snapshot with opaque key %s", async (apiKey) => {
    const sourceConfig: OpenClawConfig = {
      secrets: FILE_SECRETS,
      models: configForProviders({
        vllm: {
          baseUrl: "https://vllm.example/v1",
          apiKey: VLLM_KEY_REF,
          models: [],
        },
      }).models,
    };
    const sourceProvider = expectDefined(
      sourceConfig.models?.providers?.vllm,
      "source vLLM provider",
    );
    const runtimeConfig: OpenClawConfig = {
      ...sourceConfig,
      models: {
        providers: {
          vllm: {
            ...sourceProvider,
            apiKey,
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    try {
      for (const config of [sourceConfig, runtimeConfig]) {
        const respond = await listModels({
          view: "all",
          runtimeConfig: config,
          loadGatewayModelCatalog: catalogLoader([LLAMA_SECURE]),
        });

        expect.soft(respond).toHaveBeenCalledWith(
          true,
          {
            models: [{ ...LLAMA_SECURE, available: true }],
          },
          undefined,
        );
      }
    } finally {
      clearRuntimeConfigSnapshot();
    }
  });

  it("does not mark catalog rows available from expired OAuth profiles", async () => {
    await withModelsTestState({}, async (state) => {
      await state.writeAuthProfiles(
        createDemoOAuthStore({
          access: "expired-access",
          expires: Date.now() - 60_000,
        }),
      );

      await expectDemoAvailability(false);
    });
  });

  it("does not mix refreshed persisted OAuth into a stale runtime generation", async () => {
    await withModelsTestState({}, async (state) => {
      const agentDir = state.agentDir();
      await state.writeAuthProfiles(
        createDemoOAuthStore({
          access: "refreshed-access",
          expires: Date.now() + 60 * 60_000,
        }),
      );
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir,
          store: createDemoOAuthStore({
            access: "expired-access",
            expires: Date.now() - 60_000,
          }),
        },
      ]);

      await expectDemoAvailability(false);
    });
  });

  it.each([
    {
      name: "env",
      tokenRef: { source: "env", provider: "default", id: "DEMO_PROVIDER_TOKEN" },
      env: { DEMO_PROVIDER_TOKEN: "test-token" },
      runtimeConfig: undefined,
      available: true,
    },
    {
      name: "file",
      tokenRef: { source: "file", provider: "mounted-json", id: "/providers/demo/token" },
      env: {},
      runtimeConfig: { secrets: FILE_SECRETS },
      available: false,
    },
  ] as const)("projects $name SecretRef-backed profile availability", async (fixture) => {
    await withModelsTestState({ env: fixture.env }, async (state) => {
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          [`demo-provider:${fixture.name}`]: {
            type: "token",
            provider: "demo-provider",
            tokenRef: fixture.tokenRef,
            expires: Date.now() + 60_000,
          },
        },
      });
      await expectDemoAvailability(fixture.available, fixture.runtimeConfig);
    });
  });

  it("hides inline provider keys during billing cooldown from model browsing", async () => {
    // Regression: the models.list availability checker loaded the auth store
    // for profile checks but did not pass it to the runtime availability check,
    // so inline provider keys in billing cooldown stayed browseable.
    await withModelsTestState({}, async (state) => {
      const runtimeConfig = configForProviders({
        cliproxyapi: {
          api: "openai-responses",
          baseUrl: "https://cliproxy.example/v1",
          apiKey: "sk-inline-cooldown", // pragma: allowlist secret
          models: [],
        },
      }) as unknown as OpenClawConfig;
      const catalog = [{ id: "qwen-remote", name: "Qwen Remote", provider: "cliproxyapi" }];
      const writeCooldown = (disabledUntil: number) =>
        state.writeAuthProfiles({
          version: 1,
          profiles: {},
          usageStats: {
            "inline-api-key:cliproxyapi": {
              disabledUntil,
              disabledReason: "billing",
            },
          },
        });

      const billingCooldownUntil = Date.now() + 60_000;
      await writeCooldown(billingCooldownUntil);
      const cooled = requestModelsList({
        view: "all",
        runtimeConfig,
        loadGatewayModelCatalog: catalogLoader(catalog),
      });
      await cooled.request;
      expectModels(cooled.respond, [
        {
          id: "qwen-remote",
          name: "Qwen Remote",
          provider: "cliproxyapi",
          available: false,
          unavailableReason: "cooldown",
          unavailableUntil: billingCooldownUntil,
        },
      ]);

      // Expired cooldown proves the store reaches the runtime check instead
      // of the row being unavailable for an unrelated reason.
      await writeCooldown(Date.now() - 60_000);
      const recovered = requestModelsList({
        view: "all",
        runtimeConfig,
        loadGatewayModelCatalog: catalogLoader(catalog),
      });
      await recovered.request;
      expectModels(recovered.respond, [
        { id: "qwen-remote", name: "Qwen Remote", provider: "cliproxyapi", available: true },
      ]);
    });
  });

  it("uses an exact hydrated runtime profile SecretRef as read-only proof", async () => {
    await withModelsTestState({}, async (state) => {
      const tokenRef = {
        source: "file" as const,
        provider: "mounted-json",
        id: "/providers/demo/token",
      };
      const persisted = {
        version: 1 as const,
        profiles: {
          "demo-provider:file": {
            type: "token" as const,
            provider: "demo-provider",
            tokenRef,
            expires: Date.now() + 10 * 60_000,
          },
        },
      };
      await state.writeAuthProfiles(persisted);
      replaceRuntimeAuthProfileStoreSnapshots([
        {
          agentDir: state.agentDir(),
          store: {
            ...persisted,
            profiles: {
              "demo-provider:file": {
                ...persisted.profiles["demo-provider:file"],
                token: "resolved-runtime-token",
              },
            },
          },
        },
      ]);
      await expectDemoAvailability(true, { secrets: FILE_SECRETS });
    });
  });

  it.each([
    {
      name: "unregistered file SecretRef",
      apiKey: VLLM_KEY_REF,
      secrets: undefined,
      available: false,
      unavailableReason: "auth-failed",
    },
    {
      name: "unhydrated file SecretRef",
      apiKey: VLLM_KEY_REF,
      secrets: FILE_SECRETS,
      available: false,
      unavailableReason: undefined,
    },
    {
      name: "legacy managed marker",
      apiKey: "secretref-managed",
      secrets: undefined,
      available: true,
      unavailableReason: undefined,
    },
  ] as const)("honors $name ownership when another auth profile is usable", async (fixture) => {
    await withModelsTestState(
      {
        env: {
          OPENCLAW_TEST_PROFILE_API_KEY: "test-token",
          VLLM_API_KEY: undefined,
        },
      },
      async (state) => {
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "vllm:env": {
              type: "api_key",
              provider: "vllm",
              keyRef: {
                source: "env",
                provider: "default",
                id: "OPENCLAW_TEST_PROFILE_API_KEY",
              },
            },
          },
        });

        const cfg = {
          agents: {
            defaults: {
              models: {
                "vllm/*": {},
              },
            },
          },
          models: configForProviders({
            vllm: {
              apiKey: fixture.apiKey,
            },
          }).models,
          ...(fixture.secrets ? { secrets: fixture.secrets } : {}),
        } as unknown as OpenClawConfig;

        await expectModelsList(
          {
            view: "all",
            runtimeConfig: cfg,
            loadGatewayModelCatalog: catalogLoader([LLAMA_SECURE]),
          },
          [
            {
              ...LLAMA_SECURE,
              available: fixture.available,
              ...(fixture.unavailableReason
                ? { unavailableReason: fixture.unavailableReason }
                : {}),
            },
          ],
        );
      },
    );
  });

  it("projects only public model fields", async () => {
    await expectModelsList(
      {
        view: "all",
        loadGatewayModelCatalog: catalogLoader([
          {
            ...EXPECTED_DEMO_IDENTITY,
            contextWindow: 0,
            reasoning: "yes",
            api: "openai-responses",
            baseUrl: "https://private.example.test/v1",
            authRequirement: "api-key",
            agentRuntime: { id: "private-runtime" },
            params: { private: true },
          },
        ]),
      },
      [
        {
          ...EXPECTED_DEMO_IDENTITY,
          local: false,
          available: false,
          unavailableReason: "missing-auth",
        },
      ],
    );
  });

  it("projects ordered thinking profiles without exposing raw compatibility metadata", async () => {
    const respond = await listModels({
      view: "all",
      loadGatewayModelCatalog: catalogLoader([
        {
          id: "reasoning-model",
          name: "Reasoning Model",
          provider: "demo-provider",
          reasoning: true,
          compat: {
            supportedReasoningEfforts: ["max", "xhigh"],
            privateRouteHint: "do-not-publish",
          },
        },
      ]),
    });

    const payload = modelPayload(respond);
    expect(payload.models).toEqual([
      expect.objectContaining({
        id: "reasoning-model",
        thinkingLevels: thinkingLevels("off minimal low medium high xhigh max ultra"),
        thinkingDefault: "medium",
      }),
    ]);
    expect(payload.models[0]).not.toHaveProperty("compat");
  });

  it.each([
    { name: "model Fast", modelDefault: true, expected: true },
    { name: "model Standard", modelDefault: false, expected: false },
    { name: "model Auto", modelDefault: "auto", expected: "auto" },
    {
      name: "agent Fast over model Standard",
      agentDefault: true,
      modelDefault: false,
      expected: true,
    },
  ] as const)("projects the $name default", async ({ agentDefault, modelDefault, expected }) => {
    const respond = await listModels({
      view: "all",
      agentId: "main",
      runtimeConfig: {
        agents: {
          defaults: {
            models: { "openai/gpt-5.6-luna": { params: { fastMode: modelDefault } } },
          },
          entries: {
            main: agentDefault === undefined ? {} : { fastModeDefault: agentDefault },
          },
        },
      },
      loadGatewayModelCatalog: catalogLoader([
        { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", provider: "openai" },
      ]),
    });

    const payload = modelPayload(respond);
    expect(payload.models[0]).toMatchObject({ effectiveFastMode: expected });
  });

  it("projects the effective context budget without exposing model input metadata", async () => {
    await expectModelsList(
      {
        view: "all",
        loadGatewayModelCatalog: catalogLoader([
          {
            id: "vision-model",
            name: "Vision Model",
            provider: "demo-provider",
            contextWindow: 128_000,
            contextTokens: 96_000,
            input: ["text", "image", "private-runtime-capability", "image"],
          },
        ]),
      },
      [
        {
          id: "vision-model",
          name: "Vision Model",
          provider: "demo-provider",
          available: false,
          unavailableReason: "missing-auth",
          contextWindow: 128_000,
          contextTokens: 96_000,
        },
      ],
    );
  });

  it("propagates catalog load errors to the dispatch backstop", async () => {
    const { request, respond } = requestModelsList({
      view: "configured",
      loadGatewayModelCatalog: vi.fn(() => Promise.reject(new Error("catalog failed"))),
    });
    await expect(request).rejects.toThrow("catalog failed");
    expect(respond).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
