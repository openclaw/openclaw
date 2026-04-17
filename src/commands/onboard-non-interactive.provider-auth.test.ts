import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  createThrowingRuntime,
  type NonInteractiveRuntime,
} from "./onboard-non-interactive.test-helpers.js";

type OnboardEnv = {
  configPath: string;
  runtime: NonInteractiveRuntime;
};
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const MINIMAX_API_BASE_URL = "https://api.minimax.chat/v1";
const MINIMAX_CN_API_BASE_URL = "https://api.minimax.chat/v1";
const OPENAI_DEFAULT_MODEL = "openai/gpt-5.4";
const ZAI_CODING_GLOBAL_BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const ZAI_CODING_CN_BASE_URL = "https://open.bigmodel.cn/api/coding/paas/v4";
const ZAI_GLOBAL_BASE_URL = "https://api.z.ai/api/paas/v4";
const TEST_AUTH_STORE_VERSION = 1;
const TEST_MAIN_AUTH_STORE_KEY = "__main__";

const ensureWorkspaceAndSessionsMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
const testConfigFile = vi.hoisted(() => ({ raw: null as string | null }));
const readConfigFileSnapshotMock = vi.hoisted(() =>
  vi.fn(async () => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("OPENCLAW_CONFIG_PATH must be set for provider auth onboarding tests");
    }
    const raw = testConfigFile.raw;
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const hash = raw === null ? undefined : crypto.createHash("sha256").update(raw).digest("hex");
    return {
      path: path.resolve(configPath),
      exists: raw !== null,
      valid: true,
      raw,
      hash,
      config: structuredClone(parsed),
      sourceConfig: structuredClone(parsed),
      runtimeConfig: structuredClone(parsed),
    };
  }),
);
const replaceConfigFileMock = vi.hoisted(() =>
  vi.fn(async (params: { nextConfig: unknown }) => {
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("OPENCLAW_CONFIG_PATH must be set for provider auth onboarding tests");
    }
    testConfigFile.raw = `${JSON.stringify(params.nextConfig, null, 2)}\n`;
    return {
      path: configPath,
      previousHash: null,
      snapshot: {},
      nextConfig: params.nextConfig,
    };
  }),
);
const testAuthProfileStores = vi.hoisted(
  () => new Map<string, { version: number; profiles: Record<string, Record<string, unknown>> }>(),
);
const upsertAuthProfileWithLockMock = vi.hoisted(() =>
  vi.fn(
    async (params: {
      profileId: string;
      credential: Record<string, unknown>;
      agentDir?: string;
    }) => {
      upsertAuthProfile(params);
    },
  ),
);

function normalizeStoredSecret(value: unknown): string {
  return typeof value === "string" ? value.replaceAll("\r", "").replaceAll("\n", "").trim() : "";
}

function cloneTestAuthStore(store: {
  version: number;
  profiles: Record<string, Record<string, unknown>>;
}) {
  return structuredClone(store);
}

function writeRuntimeAuthSnapshots() {
  if (!replaceRuntimeAuthProfileStoreSnapshots) {
    return;
  }
  replaceRuntimeAuthProfileStoreSnapshots(
    Array.from(testAuthProfileStores.entries()).map(([key, store]) =>
      key === TEST_MAIN_AUTH_STORE_KEY
        ? { store: cloneTestAuthStore(store) as never }
        : { agentDir: key, store: cloneTestAuthStore(store) as never },
    ),
  );
}

function getOrCreateTestAuthStore(agentDir?: string) {
  const key = agentDir?.trim() || TEST_MAIN_AUTH_STORE_KEY;
  let store = testAuthProfileStores.get(key);
  if (!store) {
    store = { version: TEST_AUTH_STORE_VERSION, profiles: {} };
    testAuthProfileStores.set(key, store);
  }
  return store;
}

function upsertAuthProfile(params: {
  profileId: string;
  credential: Record<string, unknown>;
  agentDir?: string;
}) {
  const credential =
    params.credential.type === "api_key" && typeof params.credential.key === "string"
      ? {
          ...params.credential,
          key: normalizeStoredSecret(params.credential.key),
        }
      : params.credential.type === "token" && typeof params.credential.token === "string"
        ? {
            ...params.credential,
            token: normalizeStoredSecret(params.credential.token),
          }
        : params.credential;
  for (const targetAgentDir of new Set([undefined, params.agentDir])) {
    const store = getOrCreateTestAuthStore(targetAgentDir);
    store.profiles[params.profileId] = credential;
  }
  writeRuntimeAuthSnapshots();
}

vi.mock("../config/io.js", () => ({
  createConfigIO: () => ({ configPath: process.env.OPENCLAW_CONFIG_PATH ?? "openclaw.json" }),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  replaceConfigFile: replaceConfigFileMock,
  resolveGatewayPort: (cfg?: { gateway?: { port?: unknown } }) =>
    typeof cfg?.gateway?.port === "number" ? cfg.gateway.port : 18789,
}));

vi.mock("../agents/auth-profiles/upsert-with-lock.js", () => ({
  upsertAuthProfileWithLock: upsertAuthProfileWithLockMock,
}));

vi.mock("./onboard-non-interactive/local/auth-choice.plugin-providers.js", async () => {
  function resolveDefaultAgentId(config: {
    agents?: { list?: Array<{ id?: string; default?: boolean }> };
  }): string {
    return config.agents?.list?.find((agent) => agent.default)?.id?.trim() || "main";
  }

  function resolveAgentDir(_config: unknown, agentId: string): string {
    return path.join(process.env.OPENCLAW_STATE_DIR || "/tmp/openclaw-test", "agents", agentId);
  }

  function resolveAgentWorkspaceDir(): string | undefined {
    return undefined;
  }

  function resolveDefaultAgentWorkspaceDir(): string {
    return "/tmp/openclaw-workspace";
  }

  function enablePluginInConfig(config: Record<string, unknown>): {
    enabled: true;
    config: Record<string, unknown>;
  } {
    return { enabled: true, config };
  }

  async function detectZaiEndpoint(params: {
    apiKey: string;
    endpoint?: "coding-global" | "coding-cn";
  }): Promise<{ baseUrl: string; modelId: string } | null> {
    const baseUrl =
      params.endpoint === "coding-global"
        ? ZAI_CODING_GLOBAL_BASE_URL
        : params.endpoint === "coding-cn"
          ? ZAI_CODING_CN_BASE_URL
          : ZAI_GLOBAL_BASE_URL;
    const modelIds = params.endpoint === "coding-cn" ? ["glm-5.1", "glm-4.7"] : ["glm-5.1"];
    for (const modelId of modelIds) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${params.apiKey}` },
        body: JSON.stringify({ model: modelId }),
      });
      if (response.status === 200) {
        return { baseUrl, modelId };
      }
    }
    return null;
  }

  const ZAI_FALLBACKS = {
    "zai-api-key": {
      baseUrl: ZAI_GLOBAL_BASE_URL,
      modelId: "glm-5.1",
    },
    "zai-coding-cn": {
      baseUrl: ZAI_CODING_CN_BASE_URL,
      modelId: "glm-4.7",
    },
    "zai-coding-global": {
      baseUrl: ZAI_CODING_GLOBAL_BASE_URL,
      modelId: "glm-5.1",
    },
  } as const;

  type HandlerContext = {
    authChoice: string;
    config: Record<string, unknown>;
    baseConfig: Record<string, unknown>;
    opts: Record<string, unknown>;
    runtime: {
      error: (message: string) => void;
      exit: (code: number) => void;
      log: (s: string) => void;
    };
    agentDir?: string;
    workspaceDir?: string;
    resolveApiKey: (input: {
      provider: string;
      flagValue?: string;
      flagName: `--${string}`;
      envVar: string;
      envVarName?: string;
      allowProfile?: boolean;
      required?: boolean;
    }) => Promise<{
      key: string;
      source: "profile" | "env" | "flag";
      envVarName?: string;
    } | null>;
    toApiKeyCredential: (input: {
      provider: string;
      resolved: {
        key: string;
        source: "profile" | "env" | "flag";
        envVarName?: string;
      };
      email?: string;
      metadata?: Record<string, string>;
    }) => Record<string, unknown> | null;
  };

  type ChoiceHandler = {
    providerId: string;
    label: string;
    pluginId?: string;
    runNonInteractive: (ctx: HandlerContext) => Promise<unknown>;
  };

  function normalizeText(value: unknown): string {
    return typeof value === "string" ? value.replaceAll("\r", "").replaceAll("\n", "").trim() : "";
  }

  function withProviderConfig(
    cfg: Record<string, unknown>,
    providerId: string,
    patch: Record<string, unknown>,
  ): Record<string, unknown> {
    const models =
      cfg.models && typeof cfg.models === "object" ? (cfg.models as Record<string, unknown>) : {};
    const providers =
      models.providers && typeof models.providers === "object"
        ? (models.providers as Record<string, unknown>)
        : {};
    const existing =
      providers[providerId] && typeof providers[providerId] === "object"
        ? (providers[providerId] as Record<string, unknown>)
        : {};
    return {
      ...cfg,
      models: {
        ...models,
        providers: {
          ...providers,
          [providerId]: {
            ...existing,
            ...patch,
          },
        },
      },
    };
  }

  function buildTestProviderModel(
    id: string,
    params?: {
      reasoning?: boolean;
      input?: Array<"text" | "image">;
      contextWindow?: number;
      maxTokens?: number;
    },
  ): Record<string, unknown> {
    return {
      id,
      name: id,
      reasoning: params?.reasoning ?? false,
      input: params?.input ?? ["text"],
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      contextWindow: params?.contextWindow ?? 131072,
      maxTokens: params?.maxTokens ?? 16384,
    };
  }

  function applyAuthProfileConfig(
    cfg: Record<string, unknown>,
    params: {
      profileId: string;
      provider: string;
      mode: "api_key" | "oauth" | "token";
      email?: string;
      displayName?: string;
    },
  ): Record<string, unknown> {
    const auth =
      cfg.auth && typeof cfg.auth === "object" ? (cfg.auth as Record<string, unknown>) : {};
    const profiles =
      auth.profiles && typeof auth.profiles === "object"
        ? (auth.profiles as Record<string, unknown>)
        : {};
    return {
      ...cfg,
      auth: {
        ...auth,
        profiles: {
          ...profiles,
          [params.profileId]: {
            provider: params.provider,
            mode: params.mode,
            ...(params.email ? { email: params.email } : {}),
            ...(params.displayName ? { displayName: params.displayName } : {}),
          },
        },
      },
    };
  }

  function applyPrimaryModel(cfg: Record<string, unknown>, model: string): Record<string, unknown> {
    const agents =
      cfg.agents && typeof cfg.agents === "object" ? (cfg.agents as Record<string, unknown>) : {};
    const defaults =
      agents.defaults && typeof agents.defaults === "object"
        ? (agents.defaults as Record<string, unknown>)
        : {};
    const models =
      defaults.models && typeof defaults.models === "object"
        ? (defaults.models as Record<string, unknown>)
        : {};
    return {
      ...cfg,
      agents: {
        ...agents,
        defaults: {
          ...defaults,
          model: {
            primary: model,
          },
          models: {
            ...models,
            [model]: models[model] ?? {},
          },
        },
      },
    };
  }

  function createApiKeyChoice(params: {
    providerId: string;
    label: string;
    optionKey: string;
    flagName: `--${string}`;
    envVar: string;
    choiceId: string;
    pluginId?: string;
    defaultModel?: string;
    profileId?: string;
    profileIds?: string[];
    applyConfig?: (cfg: Record<string, unknown>) => Record<string, unknown>;
  }): ChoiceHandler {
    const profileIds =
      params.profileIds?.map((value) => value.trim()).filter(Boolean) ??
      (params.profileId ? [params.profileId] : [`${params.providerId}:default`]);
    return {
      providerId: params.providerId,
      label: params.label,
      ...(params.pluginId ? { pluginId: params.pluginId } : {}),
      runNonInteractive: async (ctx) => {
        const resolved = await ctx.resolveApiKey({
          provider: params.providerId,
          flagValue: normalizeText(ctx.opts[params.optionKey]),
          flagName: params.flagName,
          envVar: params.envVar,
        });
        if (!resolved) {
          return null;
        }
        if (resolved.source !== "profile") {
          for (const profileId of profileIds) {
            const credential = ctx.toApiKeyCredential({
              provider: profileId.split(":", 1)[0]?.trim() || params.providerId,
              resolved,
            });
            if (!credential) {
              return null;
            }
            upsertAuthProfile({
              profileId,
              credential,
              agentDir: ctx.agentDir,
            });
          }
        }
        let next = ctx.config;
        for (const profileId of profileIds) {
          next = applyAuthProfileConfig(next, {
            profileId,
            provider: profileId.split(":", 1)[0]?.trim() || params.providerId,
            mode: "api_key",
          });
        }
        if (params.applyConfig) {
          next = params.applyConfig(next);
        }
        return params.defaultModel ? applyPrimaryModel(next, params.defaultModel) : next;
      },
    };
  }

  function createZaiChoice(
    choiceId: "zai-api-key" | "zai-coding-cn" | "zai-coding-global",
  ): ChoiceHandler {
    return {
      providerId: "zai",
      label: "Z.AI",
      runNonInteractive: async (ctx) => {
        const resolved = await ctx.resolveApiKey({
          provider: "zai",
          flagValue: normalizeText(ctx.opts.zaiApiKey),
          flagName: "--zai-api-key",
          envVar: "ZAI_API_KEY",
        });
        if (!resolved) {
          return null;
        }
        if (resolved.source !== "profile") {
          const credential = ctx.toApiKeyCredential({
            provider: "zai",
            resolved,
          });
          if (!credential) {
            return null;
          }
          upsertAuthProfile({
            profileId: "zai:default",
            credential: credential as never,
            agentDir: ctx.agentDir,
          });
        }
        const detected = await detectZaiEndpoint({
          apiKey: resolved.key,
          ...(choiceId === "zai-coding-global"
            ? { endpoint: "coding-global" as const }
            : choiceId === "zai-coding-cn"
              ? { endpoint: "coding-cn" as const }
              : {}),
        });
        const fallback = ZAI_FALLBACKS[choiceId];
        let next = applyAuthProfileConfig(ctx.config as never, {
          profileId: "zai:default",
          provider: "zai",
          mode: "api_key",
        });
        next = withProviderConfig(next, "zai", {
          baseUrl: detected?.baseUrl ?? fallback.baseUrl,
          api: "openai-completions",
          models: [
            buildTestProviderModel(detected?.modelId ?? fallback.modelId, {
              input: ["text"],
            }),
          ],
        });
        return applyPrimaryModel(next as never, `zai/${detected?.modelId ?? fallback.modelId}`);
      },
    };
  }

  const choiceMap = new Map<string, ChoiceHandler>([
    [
      "setup-token",
      {
        providerId: "anthropic",
        label: "Anthropic setup-token",
        async runNonInteractive(ctx) {
          const token = normalizeText(ctx.opts.token);
          if (!token) {
            ctx.runtime.error("Anthropic setup-token auth requires --token.");
            ctx.runtime.exit(1);
            return null;
          }
          upsertAuthProfile({
            profileId: (ctx.opts.tokenProfileId as string | undefined) ?? "anthropic:default",
            credential: {
              type: "token",
              provider: "anthropic",
              token,
            } as never,
            agentDir: ctx.agentDir,
          });
          const withProfile = applyAuthProfileConfig(ctx.config as never, {
            profileId: (ctx.opts.tokenProfileId as string | undefined) ?? "anthropic:default",
            provider: "anthropic",
            mode: "token",
          });
          return applyPrimaryModel(withProfile, "anthropic/claude-sonnet-4-6");
        },
      },
    ],
    [
      "apiKey",
      createApiKeyChoice({
        providerId: "anthropic",
        label: "Anthropic",
        choiceId: "apiKey",
        optionKey: "anthropicApiKey",
        flagName: "--anthropic-api-key",
        envVar: "ANTHROPIC_API_KEY",
      }),
    ],
    [
      "minimax-global-api",
      createApiKeyChoice({
        providerId: "minimax",
        label: "MiniMax",
        choiceId: "minimax-global-api",
        optionKey: "minimaxApiKey",
        flagName: "--minimax-api-key",
        envVar: "MINIMAX_API_KEY",
        profileId: "minimax:global",
        defaultModel: "minimax/MiniMax-M2.7",
        applyConfig: (cfg) =>
          withProviderConfig(cfg, "minimax", {
            baseUrl: MINIMAX_API_BASE_URL,
            api: "anthropic-messages",
            models: [buildTestProviderModel("MiniMax-M2.7")],
          }),
      }),
    ],
    [
      "minimax-cn-api",
      createApiKeyChoice({
        providerId: "minimax",
        label: "MiniMax",
        choiceId: "minimax-cn-api",
        optionKey: "minimaxApiKey",
        flagName: "--minimax-api-key",
        envVar: "MINIMAX_API_KEY",
        profileId: "minimax:cn",
        defaultModel: "minimax/MiniMax-M2.7",
        applyConfig: (cfg) =>
          withProviderConfig(cfg, "minimax", {
            baseUrl: MINIMAX_CN_API_BASE_URL,
            api: "anthropic-messages",
            models: [buildTestProviderModel("MiniMax-M2.7")],
          }),
      }),
    ],
    ["zai-api-key", createZaiChoice("zai-api-key")],
    ["zai-coding-cn", createZaiChoice("zai-coding-cn")],
    ["zai-coding-global", createZaiChoice("zai-coding-global")],
    [
      "xai-api-key",
      createApiKeyChoice({
        providerId: "xai",
        label: "xAI",
        choiceId: "xai-api-key",
        optionKey: "xaiApiKey",
        flagName: "--xai-api-key",
        envVar: "XAI_API_KEY",
        defaultModel: "xai/grok-4",
      }),
    ],
    [
      "openai-api-key",
      createApiKeyChoice({
        providerId: "openai",
        label: "OpenAI",
        choiceId: "openai-api-key",
        optionKey: "openaiApiKey",
        flagName: "--openai-api-key",
        envVar: "OPENAI_API_KEY",
        defaultModel: OPENAI_DEFAULT_MODEL,
      }),
    ],
    [
      "opencode-zen",
      createApiKeyChoice({
        providerId: "opencode",
        label: "OpenCode",
        choiceId: "opencode-zen",
        optionKey: "opencodeApiKey",
        flagName: "--opencode-api-key",
        envVar: "OPENCODE_ZEN_API_KEY",
        profileIds: ["opencode:default", "opencode-go:default"],
        defaultModel: "opencode/claude-opus-4-6",
      }),
    ],
    [
      "qwen-api-key",
      createApiKeyChoice({
        providerId: "qwen",
        label: "Qwen Cloud",
        choiceId: "qwen-api-key",
        optionKey: "modelstudioApiKey",
        flagName: "--modelstudio-api-key",
        envVar: "QWEN_API_KEY",
        defaultModel: "qwen/qwen3.5-plus",
        applyConfig: (cfg) =>
          withProviderConfig(cfg, "qwen", {
            baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
            api: "openai-completions",
            models: [buildTestProviderModel("qwen3.5-plus")],
          }),
      }),
    ],
  ]);

  return {
    applyNonInteractivePluginProviderChoice: async (params: {
      nextConfig: Record<string, unknown>;
      authChoice: string;
      opts: Record<string, unknown>;
      runtime: HandlerContext["runtime"];
      baseConfig: Record<string, unknown>;
      resolveApiKey: HandlerContext["resolveApiKey"];
      toApiKeyCredential: HandlerContext["toApiKeyCredential"];
    }) => {
      const handler = choiceMap.get(params.authChoice);
      if (!handler) {
        return undefined;
      }

      const enableResult = enablePluginInConfig(
        params.nextConfig as never,
        handler.pluginId ?? handler.providerId,
      );
      if (!enableResult.enabled) {
        params.runtime.error(
          `${handler.label} plugin is disabled (${enableResult.reason ?? "blocked"}).`,
        );
        params.runtime.exit(1);
        return null;
      }

      const agentId = resolveDefaultAgentId(enableResult.config);
      const agentDir = resolveAgentDir(enableResult.config, agentId);
      const workspaceDir =
        resolveAgentWorkspaceDir(enableResult.config, agentId) ?? resolveDefaultAgentWorkspaceDir();

      return await handler.runNonInteractive({
        authChoice: params.authChoice,
        config: enableResult.config,
        baseConfig: params.baseConfig,
        opts: params.opts,
        runtime: params.runtime,
        agentDir,
        workspaceDir,
        resolveApiKey: params.resolveApiKey,
        toApiKeyCredential: params.toApiKeyCredential,
      });
    },
  };
});

vi.mock("./onboard-helpers.js", () => {
  const normalizeGatewayTokenInput = (value: unknown): string => {
    if (typeof value !== "string") {
      return "";
    }
    const trimmed = value.trim();
    return trimmed === "undefined" || trimmed === "null" ? "" : trimmed;
  };
  return {
    DEFAULT_WORKSPACE: "/tmp/openclaw-workspace",
    applyWizardMetadata: (cfg: unknown) => cfg,
    ensureWorkspaceAndSessions: ensureWorkspaceAndSessionsMock,
    normalizeGatewayTokenInput,
    randomToken: () => "tok_generated_provider_auth_test_token",
    resolveControlUiLinks: ({ port }: { port: number }) => ({
      httpUrl: `http://127.0.0.1:${port}`,
      wsUrl: `ws://127.0.0.1:${port}`,
    }),
    waitForGatewayReachable: async () => ({ ok: true }),
  };
});

const NON_INTERACTIVE_DEFAULT_OPTIONS = {
  nonInteractive: true,
  skipHealth: true,
  skipChannels: true,
  json: true,
} as const;

let runNonInteractiveSetup: typeof import("./onboard-non-interactive.js").runNonInteractiveSetup;
let clearRuntimeAuthProfileStoreSnapshots: typeof import("../agents/auth-profiles.js").clearRuntimeAuthProfileStoreSnapshots;
let replaceRuntimeAuthProfileStoreSnapshots: typeof import("../agents/auth-profiles.js").replaceRuntimeAuthProfileStoreSnapshots;
let resetFileLockStateForTest: typeof import("../infra/file-lock.js").resetFileLockStateForTest;
let clearPluginDiscoveryCache: typeof import("../plugins/discovery.js").clearPluginDiscoveryCache;
let clearPluginManifestRegistryCache: typeof import("../plugins/manifest-registry.js").clearPluginManifestRegistryCache;

type ProviderAuthConfigSnapshot = {
  auth?: { profiles?: Record<string, { provider?: string; mode?: string }> };
  agents?: { defaults?: { model?: { primary?: string } } };
  models?: {
    providers?: Record<
      string,
      {
        baseUrl?: string;
        api?: string;
        apiKey?: string | { source?: string; id?: string };
        models?: Array<{ id?: string }>;
      }
    >;
  };
};

function createZaiFetchMock(responses: Record<string, number>): FetchLike {
  return vi.fn(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : "";
    const parsedBody =
      typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {};
    const key = `${url}::${parsedBody.model ?? ""}`;
    const status = responses[key] ?? 404;
    return new Response(
      JSON.stringify(
        status === 200 ? { ok: true } : { error: { code: "unsupported", message: "unsupported" } },
      ),
      {
        status,
        headers: { "content-type": "application/json" },
      },
    );
  });
}

async function withZaiProbeFetch<T>(
  responses: Record<string, number>,
  run: (fetchMock: FetchLike) => Promise<T>,
): Promise<T> {
  const originalVitest = process.env.VITEST;
  delete process.env.VITEST;
  const fetchMock = createZaiFetchMock(responses);
  vi.stubGlobal("fetch", fetchMock);
  try {
    return await run(fetchMock);
  } finally {
    vi.unstubAllGlobals();
    if (originalVitest === undefined) {
      delete process.env.VITEST;
    } else {
      process.env.VITEST = originalVitest;
    }
  }
}

function expectZaiProbeCalls(
  fetchMock: FetchLike,
  expected: Array<{ url: string; modelId: string }>,
): void {
  const calls = (
    fetchMock as unknown as {
      mock: { calls: Array<[RequestInfo | URL, RequestInit?]> };
    }
  ).mock.calls;

  expect(calls).toHaveLength(expected.length);
  for (const [index, probe] of expected.entries()) {
    const [input, init] = calls[index] ?? [];
    const requestUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input && typeof input === "object" && "url" in input && typeof input.url === "string"
            ? input.url
            : undefined;
    expect(requestUrl).toBe(probe.url);
    expect(init?.method).toBe("POST");
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {};
    expect(body.model).toBe(probe.modelId);
  }
}

async function removeDirWithRetry(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const isTransient = code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM";
      if (!isTransient || attempt === 4) {
        throw error;
      }
      await delay(10 * (attempt + 1));
    }
  }
}

async function withOnboardEnv(
  prefix: string,
  run: (ctx: OnboardEnv) => Promise<void>,
): Promise<void> {
  const tempHome = await makeTempWorkspace(prefix);
  const configPath = path.join(tempHome, "openclaw.json");
  const runtime = createThrowingRuntime();

  try {
    clearTestConfigFile();
    await withEnvAsync(
      {
        HOME: tempHome,
        OPENCLAW_STATE_DIR: tempHome,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_GATEWAY_PASSWORD: undefined,
        CUSTOM_API_KEY: undefined,
        OPENCLAW_DISABLE_CONFIG_CACHE: "1",
        OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
        OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE: "1",
      },
      async () => {
        await run({ configPath, runtime });
      },
    );
  } finally {
    await removeDirWithRetry(tempHome);
  }
}

function clearTestConfigFile(): void {
  testConfigFile.raw = null;
}

function readTestConfig<T>(): T {
  return (testConfigFile.raw ? JSON.parse(testConfigFile.raw) : {}) as T;
}

async function runNonInteractiveSetupWithDefaults(
  runtime: NonInteractiveRuntime,
  options: Record<string, unknown>,
): Promise<void> {
  await runNonInteractiveSetup(
    {
      ...NON_INTERACTIVE_DEFAULT_OPTIONS,
      ...options,
    },
    runtime,
  );
}

async function runOnboardingAndReadConfig(
  env: OnboardEnv,
  options: Record<string, unknown>,
): Promise<ProviderAuthConfigSnapshot> {
  await runNonInteractiveSetupWithDefaults(env.runtime, {
    skipSkills: true,
    ...options,
  });
  return readTestConfig<ProviderAuthConfigSnapshot>();
}

async function expectApiKeyProfile(params: {
  profileId: string;
  provider: string;
  key: string;
  metadata?: Record<string, string>;
}): Promise<void> {
  const store = getOrCreateTestAuthStore();
  const profile = store.profiles[params.profileId];
  expect(profile?.type).toBe("api_key");
  if (profile?.type === "api_key") {
    expect(profile.provider).toBe(params.provider);
    expect(profile.key).toBe(params.key);
    if (params.metadata) {
      expect(profile.metadata).toEqual(params.metadata);
    }
  }
}

async function loadProviderAuthOnboardModules(): Promise<void> {
  ({ runNonInteractiveSetup } = await import("./onboard-non-interactive.js"));
  ({ clearRuntimeAuthProfileStoreSnapshots, replaceRuntimeAuthProfileStoreSnapshots } =
    await import("../agents/auth-profiles.js"));
  ({ resetFileLockStateForTest } = await import("../infra/file-lock.js"));
  ({ clearPluginDiscoveryCache } = await import("../plugins/discovery.js"));
  ({ clearPluginManifestRegistryCache } = await import("../plugins/manifest-registry.js"));
}

describe("onboard (non-interactive): provider auth", () => {
  beforeAll(async () => {
    await loadProviderAuthOnboardModules();
  });

  function resetProviderAuthTestState() {
    testAuthProfileStores.clear();
    clearRuntimeAuthProfileStoreSnapshots();
    resetFileLockStateForTest();
    clearPluginDiscoveryCache();
    clearPluginManifestRegistryCache();
    ensureWorkspaceAndSessionsMock.mockClear();
  }

  beforeEach(() => {
    resetProviderAuthTestState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    testAuthProfileStores.clear();
    clearRuntimeAuthProfileStoreSnapshots();
    resetFileLockStateForTest();
    clearPluginDiscoveryCache();
    clearPluginManifestRegistryCache();
  });

  it("stores MiniMax API keys for global and CN endpoint choices", async () => {
    const scenarios = [
      { authChoice: "minimax-global-api", profileId: "minimax:global" },
      { authChoice: "minimax-cn-api", profileId: "minimax:cn" },
    ] as const;

    await withOnboardEnv("openclaw-onboard-minimax-", async (env) => {
      for (const scenario of scenarios) {
        clearTestConfigFile();
        resetProviderAuthTestState();
        const cfg = await runOnboardingAndReadConfig(env, {
          authChoice: scenario.authChoice,
          minimaxApiKey: "sk-minimax-test", // pragma: allowlist secret
        });
        expect(cfg.auth?.profiles?.[scenario.profileId]?.provider).toBe("minimax");
        expect(cfg.auth?.profiles?.[scenario.profileId]?.mode).toBe("api_key");
        await expectApiKeyProfile({
          profileId: scenario.profileId,
          provider: "minimax",
          key: "sk-minimax-test",
        });
      }
    });
  });

  it("stores Z.AI API keys across global and coding endpoint choices", async () => {
    const scenarios = [
      {
        authChoice: "zai-api-key",
        responses: { [`${ZAI_GLOBAL_BASE_URL}/chat/completions::glm-5.1`]: 200 },
        expectedCalls: [{ url: `${ZAI_GLOBAL_BASE_URL}/chat/completions`, modelId: "glm-5.1" }],
      },
      {
        authChoice: "zai-coding-cn",
        responses: {
          [`${ZAI_CODING_CN_BASE_URL}/chat/completions::glm-5.1`]: 404,
          [`${ZAI_CODING_CN_BASE_URL}/chat/completions::glm-4.7`]: 200,
        },
        expectedCalls: [
          { url: `${ZAI_CODING_CN_BASE_URL}/chat/completions`, modelId: "glm-5.1" },
          { url: `${ZAI_CODING_CN_BASE_URL}/chat/completions`, modelId: "glm-4.7" },
        ],
      },
      {
        authChoice: "zai-coding-global",
        responses: { [`${ZAI_CODING_GLOBAL_BASE_URL}/chat/completions::glm-5.1`]: 200 },
        expectedCalls: [
          { url: `${ZAI_CODING_GLOBAL_BASE_URL}/chat/completions`, modelId: "glm-5.1" },
        ],
      },
    ] as const;

    await withOnboardEnv("openclaw-onboard-zai-", async (env) => {
      for (const scenario of scenarios) {
        clearTestConfigFile();
        resetProviderAuthTestState();
        await withZaiProbeFetch(scenario.responses, async (fetchMock) => {
          const cfg = await runOnboardingAndReadConfig(env, {
            authChoice: scenario.authChoice,
            zaiApiKey: "zai-test-key", // pragma: allowlist secret
          });

          expect(cfg.auth?.profiles?.["zai:default"]?.provider).toBe("zai");
          expect(cfg.auth?.profiles?.["zai:default"]?.mode).toBe("api_key");
          expectZaiProbeCalls(fetchMock, scenario.expectedCalls);
          await expectApiKeyProfile({
            profileId: "zai:default",
            provider: "zai",
            key: "zai-test-key",
          });
        });
      }
    });
  });

  it("handles common provider API key onboarding choices", async () => {
    const scenarios: Array<{
      options: Record<string, unknown>;
      profileId?: string;
      provider?: string;
      key?: string;
      expectedModel?: string;
      expectedBaseUrl?: string;
    }> = [
      {
        options: {
          authChoice: "xai-api-key",
          xaiApiKey: "xai-test-\r\nkey",
        },
        profileId: "xai:default",
        provider: "xai",
        key: "xai-test-key",
        expectedModel: "xai/grok-4",
      },
      {
        options: {
          modelstudioApiKey: "modelstudio-test-key", // pragma: allowlist secret
        },
        profileId: "qwen:default",
        provider: "qwen",
        key: "modelstudio-test-key",
        expectedModel: "qwen/qwen3.5-plus",
        expectedBaseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      },
    ];

    await withOnboardEnv("openclaw-onboard-provider-api-keys-", async (env) => {
      for (const scenario of scenarios) {
        clearTestConfigFile();
        resetProviderAuthTestState();
        const cfg = await runOnboardingAndReadConfig(env, scenario.options);

        if (scenario.profileId && scenario.provider) {
          expect(cfg.auth?.profiles?.[scenario.profileId]?.provider).toBe(scenario.provider);
          expect(cfg.auth?.profiles?.[scenario.profileId]?.mode).toBe("api_key");
        }
        if (scenario.expectedModel) {
          expect(cfg.agents?.defaults?.model?.primary).toBe(scenario.expectedModel);
        }
        if (scenario.expectedBaseUrl) {
          expect(cfg.models?.providers?.[scenario.provider ?? ""]?.baseUrl).toBe(
            scenario.expectedBaseUrl,
          );
        }
        if (scenario.profileId && scenario.provider && scenario.key) {
          await expectApiKeyProfile({
            profileId: scenario.profileId,
            provider: scenario.provider,
            key: scenario.key,
          });
        }
      }
    });
  });

  it("stores legacy Anthropic setup-token onboarding again when explicitly selected", async () => {
    await withOnboardEnv("openclaw-onboard-token-", async ({ runtime }) => {
      const cleanToken = `sk-ant-oat01-${"a".repeat(80)}`;
      const token = `${cleanToken.slice(0, 30)}\r${cleanToken.slice(30)}`;

      await runNonInteractiveSetupWithDefaults(runtime, {
        authChoice: "setup-token",
        token,
        tokenProfileId: "anthropic:default",
      });

      const cfg = readTestConfig<ProviderAuthConfigSnapshot>();
      expect(cfg.auth?.profiles?.["anthropic:default"]?.provider).toBe("anthropic");
      expect(cfg.auth?.profiles?.["anthropic:default"]?.mode).toBe("token");
      expect(cfg.agents?.defaults?.model?.primary).toBe("anthropic/claude-sonnet-4-6");
      expect(getOrCreateTestAuthStore().profiles["anthropic:default"]).toMatchObject({
        provider: "anthropic",
        type: "token",
        token: cleanToken,
      });
    });
  });

  it("fails fast when ref mode receives explicit provider keys without env and does not leak keys", async () => {
    const scenarios = [
      {
        name: "openai",
        authChoice: "openai-api-key",
        optionKey: "openaiApiKey",
        flagName: "--openai-api-key",
        envVar: "OPENAI_API_KEY",
      },
    ] as const;

    await withOnboardEnv("openclaw-onboard-ref-flag-", async () => {
      for (const { authChoice, optionKey, flagName, envVar } of scenarios) {
        resetProviderAuthTestState();
        const runtime = createThrowingRuntime();
        const providedSecret = `${envVar.toLowerCase()}-should-not-leak`; // pragma: allowlist secret
        const options: Record<string, unknown> = {
          authChoice,
          secretInputMode: "ref", // pragma: allowlist secret
          [optionKey]: providedSecret,
          skipSkills: true,
        };
        const envOverrides: Record<string, string | undefined> = {
          [envVar]: undefined,
        };

        await withEnvAsync(envOverrides, async () => {
          let thrown: Error | undefined;
          try {
            await runNonInteractiveSetupWithDefaults(runtime, options);
          } catch (error) {
            thrown = error as Error;
          }
          expect(thrown).toBeDefined();
          const message = thrown?.message ?? "";
          expect(message).toContain(
            `${flagName} cannot be used with --secret-input-mode ref unless ${envVar} is set in env.`,
          );
          expect(message).toContain(
            `Set ${envVar} in env and omit ${flagName}, or use --secret-input-mode plaintext.`,
          );
          expect(message).not.toContain(providedSecret);
        });
      }
    });
  });

  it("stores the detected env alias as keyRef for both OpenCode runtime providers", async () => {
    await withOnboardEnv("openclaw-onboard-ref-opencode-alias-", async ({ runtime }) => {
      await withEnvAsync(
        {
          OPENCODE_API_KEY: undefined,
          OPENCODE_ZEN_API_KEY: "opencode-zen-env-key", // pragma: allowlist secret
        },
        async () => {
          await runNonInteractiveSetupWithDefaults(runtime, {
            authChoice: "opencode-zen",
            secretInputMode: "ref", // pragma: allowlist secret
            skipSkills: true,
          });

          const store = getOrCreateTestAuthStore();
          for (const profileId of ["opencode:default", "opencode-go:default"]) {
            const profile = store.profiles[profileId];
            expect(profile?.type).toBe("api_key");
            if (profile?.type === "api_key") {
              expect(profile.key).toBeUndefined();
              expect(profile.keyRef).toEqual({
                source: "env",
                provider: "default",
                id: "OPENCODE_ZEN_API_KEY",
              });
            }
          }
        },
      );
    });
  });

  it("configures custom providers from explicit or inferred non-interactive flags", async () => {
    const scenarios = [
      {
        options: {
          authChoice: "custom-api-key",
          customBaseUrl: "https://llm.example.com/v1",
          customApiKey: "custom-test-key", // pragma: allowlist secret
          customModelId: "foo-large",
          customCompatibility: "anthropic",
          skipSkills: true,
        },
        providerId: "custom-llm-example-com",
        expectedBaseUrl: "https://llm.example.com/v1",
        expectedApi: "anthropic-messages",
        expectedModel: "custom-llm-example-com/foo-large",
        modelId: "foo-large",
      },
      {
        options: {
          customBaseUrl: "https://models.custom.local/v1",
          customModelId: "local-large",
          customApiKey: "custom-test-key", // pragma: allowlist secret
          skipSkills: true,
        },
        providerId: "custom-models-custom-local",
        expectedBaseUrl: "https://models.custom.local/v1",
        expectedApi: "openai-completions",
        expectedModel: "custom-models-custom-local/local-large",
        modelId: "local-large",
      },
    ] as const;

    await withOnboardEnv("openclaw-onboard-custom-provider-", async ({ runtime }) => {
      for (const scenario of scenarios) {
        clearTestConfigFile();
        resetProviderAuthTestState();
        await runNonInteractiveSetupWithDefaults(runtime, scenario.options);
        const cfg = readTestConfig<ProviderAuthConfigSnapshot>();
        const provider = cfg.models?.providers?.[scenario.providerId];
        expect(provider?.baseUrl).toBe(scenario.expectedBaseUrl);
        expect(provider?.api).toBe(scenario.expectedApi);
        expect(provider?.apiKey).toBe("custom-test-key");
        expect(provider?.models?.some((model) => model.id === scenario.modelId)).toBe(true);
        expect(cfg.agents?.defaults?.model?.primary).toBe(scenario.expectedModel);
      }
    });
  });
});
