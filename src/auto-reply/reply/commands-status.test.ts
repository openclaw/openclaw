// Tests status command rendering for sessions, agents, diagnostics, and model defaults.
import fs from "node:fs";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { saveAuthProfileStore } from "../../agents/auth-profiles/store-runtime.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { clearAgentHarnesses, registerAgentHarness } from "../../agents/harness/registry.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import {
  seedSubagentRunForReadTest,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import * as logger from "../../logger.js";
import type { ProviderThinkingProfile } from "../../plugins/provider-thinking.types.js";
import * as statusText from "../../status/status-text.js";
import { buildStatusPluginsReply, buildStatusText } from "./commands-status.js";
import { buildKiraStatusReply, buildStatusReplyForTest } from "./commands-status.test-support.js";
import { baseCommandTestConfig, buildCommandTestParams } from "./commands.test-harness.js";

// Tests status command rendering for sessions, agents, and diagnostics.

type LoadProviderUsageSummary =
  typeof import("../../infra/provider-usage.js").loadProviderUsageSummary;

const providerUsageMock = vi.hoisted(() => ({
  loadProviderUsageSummary: vi.fn<LoadProviderUsageSummary>(async () => ({
    updatedAt: Date.now(),
    providers: [],
  })),
}));
const activeProviderThinkingMock = vi.hoisted(() => ({
  resolveThinkingProfile: vi.fn<
    (params: {
      provider: string;
      context: { modelId: string };
    }) => ProviderThinkingProfile | null | undefined
  >(() => undefined),
}));
type StatusPluginHealthSnapshot =
  import("../../status/status-plugin-health.js").StatusPluginHealthSnapshot;

const pluginHealthRuntimeMock = vi.hoisted(() => ({
  collectInstalledPluginHealthSnapshot: vi.fn(async (): Promise<StatusPluginHealthSnapshot> => ({
    plugins: [],
    diagnostics: [],
    contextEngineQuarantines: [],
    runtimeToolQuarantines: [],
    channelPluginFailures: [],
  })),
  collectRuntimePluginHealthSnapshot: vi.fn((): StatusPluginHealthSnapshot => ({
    plugins: [],
    diagnostics: [],
    contextEngineQuarantines: [],
    runtimeToolQuarantines: [],
    channelPluginFailures: [],
  })),
}));

vi.mock("../../infra/provider-usage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/provider-usage.js")>();
  return {
    ...actual,
    loadProviderUsageSummary: providerUsageMock.loadProviderUsageSummary,
  };
});

vi.mock("../../plugins/provider-thinking-active.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/provider-thinking-active.js")>()),
  resolveActiveProviderThinkingProfile: activeProviderThinkingMock.resolveThinkingProfile,
}));

vi.mock("../../status/status-plugin-health.runtime.js", () => pluginHealthRuntimeMock);

vi.mock("../../agents/harness/builtin-openclaw.js", () => ({
  createOpenClawAgentHarness: () => ({
    id: "openclaw",
    label: "OpenClaw Default",
    supports: () => ({ supported: true, priority: 0 }),
    runAttempt: async () => {
      throw new Error("not used in status tests");
    },
  }),
}));

const baseCfg = baseCommandTestConfig;
const expectedCodexRuntimeUsageAuth = [
  {
    provider: "openai",
    token: "codex-app-server",
    hookProvider: "codex",
  },
];
const codexStatusModel: ModelDefinitionConfig = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_050_000,
  contextTokens: 1_000_000,
  maxTokens: 128_000,
};

type StatusTextParams = Parameters<typeof buildStatusText>[0];

function createStatusSessionParams(statusChannel = "mobilechat") {
  return {
    sessionKey: "agent:main:main",
    parentSessionKey: "agent:main:main",
    sessionScope: "per-sender",
    statusChannel,
  } satisfies Partial<StatusTextParams>;
}

function createStatusDisplayParams(
  resolvedFastMode = false,
  resolveDefaultThinkingLevel: StatusTextParams["resolveDefaultThinkingLevel"] = async () =>
    undefined,
) {
  return {
    resolvedFastMode,
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel,
    isGroup: false,
    defaultGroupActivation: () => "mention",
  } satisfies Partial<StatusTextParams>;
}

function registerStatusCodexHarness(): void {
  const codexProviders = new Set(["codex", "openai"]);
  const harness: AgentHarness = {
    id: "codex",
    label: "Codex",
    autoSelection: { providerIds: [...codexProviders] },
    supports: (ctx) =>
      codexProviders.has(ctx.provider.trim().toLowerCase())
        ? { supported: true, priority: 100 }
        : { supported: false },
    runAttempt: async () => {
      throw new Error("not used in status tests");
    },
  };
  registerAgentHarness(harness, { ownerPluginId: "codex" });
}

function saveStatusTestAuthProfile(params: {
  dir: string;
  profileId: string;
  provider: "openai" | "anthropic";
}): void {
  saveStatusTestAuthProfiles({
    dir: params.dir,
    profiles: [{ profileId: params.profileId, provider: params.provider }],
  });
}

function saveStatusTestAuthProfiles(params: {
  dir: string;
  profiles: Array<{ profileId: string; provider: "openai" | "anthropic" }>;
}): void {
  const agentDir = path.join(params.dir, ".openclaw", "agents", "main", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  saveAuthProfileStore(
    {
      version: 1,
      profiles: Object.fromEntries(
        params.profiles.map((profile) => [
          profile.profileId,
          profile.provider === "openai"
            ? {
                type: "oauth",
                provider: profile.provider,
                access: "access-token",
                refresh: "refresh-token",
                expires: Date.now() + 60 * 60_000,
              }
            : {
                type: "api_key",
                provider: "anthropic",
                key: "anthropic-api-key",
              },
        ]),
      ),
    },
    agentDir,
    { filterExternalAuthProfiles: false, syncExternalCli: false },
  );
}

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  clearAgentHarnesses();
  providerUsageMock.loadProviderUsageSummary.mockReset();
  providerUsageMock.loadProviderUsageSummary.mockResolvedValue({
    updatedAt: Date.now(),
    providers: [],
  });
  activeProviderThinkingMock.resolveThinkingProfile.mockReset();
  activeProviderThinkingMock.resolveThinkingProfile.mockReturnValue(undefined);
  pluginHealthRuntimeMock.collectInstalledPluginHealthSnapshot.mockReset();
  pluginHealthRuntimeMock.collectInstalledPluginHealthSnapshot.mockResolvedValue({
    plugins: [],
    diagnostics: [],
    contextEngineQuarantines: [],
    runtimeToolQuarantines: [],
    channelPluginFailures: [],
  });
  pluginHealthRuntimeMock.collectRuntimePluginHealthSnapshot.mockReset();
  pluginHealthRuntimeMock.collectRuntimePluginHealthSnapshot.mockReturnValue({
    plugins: [],
    diagnostics: [],
    contextEngineQuarantines: [],
    runtimeToolQuarantines: [],
    channelPluginFailures: [],
  });
});

describe("buildStatusReply subagent summary", () => {
  beforeEach(async () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupRegistry: () => ({
        providers: [],
        cliBackends: [],
        configMigrations: [],
        autoEnableProbes: [],
        diagnostics: [],
      }),
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          pluginId: "claude-cli",
          modelProvider: "anthropic",
          config: { command: "claude" },
          bundleMcp: false,
        },
      ],
    });
    await resetSubagentRegistryForTests({ persist: false });
  });

  afterEach(async () => {
    await resetSubagentRegistryForTests({ persist: false });
  });

  it("counts ended orchestrators with active descendants as active", async () => {
    const parentKey = "agent:main:subagent:status-ended-parent";
    seedSubagentRunForReadTest({
      runId: "run-status-ended-parent",
      childSessionKey: parentKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "status orchestrator",
      cleanup: "keep",
      createdAt: Date.now() - 120_000,
      startedAt: Date.now() - 120_000,
      endedAt: Date.now() - 110_000,
      outcome: { status: "ok" },
    });
    seedSubagentRunForReadTest({
      runId: "run-status-active-child",
      childSessionKey: "agent:main:subagent:status-ended-parent:subagent:child",
      requesterSessionKey: parentKey,
      requesterDisplayKey: "subagent:status-ended-parent",
      task: "status child still running",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("🤖 Subagents: 1 active");
  });

  it("dedupes stale rows in the verbose subagent status summary", async () => {
    const childSessionKey = "agent:main:subagent:status-dedupe-worker";
    seedSubagentRunForReadTest({
      runId: "run-status-current",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "current status worker",
      cleanup: "keep",
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });
    seedSubagentRunForReadTest({
      runId: "run-status-stale",
      childSessionKey,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "stale status worker",
      cleanup: "keep",
      createdAt: Date.now() - 120_000,
      startedAt: Date.now() - 120_000,
      endedAt: Date.now() - 90_000,
      outcome: { status: "ok" },
    });

    const reply = await buildStatusReplyForTest({ verbose: true });

    expect(reply?.text).toContain("🤖 Subagents: 1 active");
    expect(reply?.text).not.toContain("· 1 done");
  });

  it("gates /status plugins behind the plugin command flag", async () => {
    const commandParams = buildCommandTestParams("/status plugins", {
      ...baseCfg,
      commands: { text: true, plugins: false },
    });

    const reply = await buildStatusPluginsReply({
      cfg: commandParams.cfg,
      command: commandParams.command,
      workspaceDir: commandParams.workspaceDir,
    });

    expect(reply?.text).toBe(
      "⚠️ /status plugins is disabled. Set commands.plugins=true to enable.",
    );
    expect(pluginHealthRuntimeMock.collectInstalledPluginHealthSnapshot).not.toHaveBeenCalled();
  });

  it("does not read a legacy native credential file from an SDK status render", async () => {
    registerStatusCodexHarness();

    await withTempHome(
      async (dir) => {
        const agentDir = path.join(dir, ".openclaw", "agents", "main", "agent");
        const codexHome = path.join(agentDir, "codex-home");
        fs.mkdirSync(codexHome, { recursive: true });
        fs.writeFileSync(
          path.join(codexHome, "auth.json"),
          JSON.stringify({
            auth_mode: "chatgpt",
            tokens: {
              access_token: "codex-access-token",
              refresh_token: "codex-refresh-token",
            },
          }),
          "utf-8",
        );

        const text = await buildStatusText({
          cfg: {
            ...baseCfg,
            agents: {
              defaults: {
                models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
              },
            },
          },
          sessionEntry: {
            sessionId: "sess-status-codex-home-oauth",
            updatedAt: 0,
          },
          ...createStatusSessionParams(),
          provider: "openai",
          model: "gpt-5.5",
          contextTokens: 32_000,
          ...createStatusDisplayParams(),
        });

        const normalized = normalizeTestText(text);
        expect(normalized).toContain("Model: openai/gpt-5.5");
        expect(normalized).toContain("Runtime: OpenAI Codex");
        expect(normalized).not.toContain("oauth (codex-cli)");
        expect(normalized).toContain("api-key (env: OPENAI_API_KEY)");
      },
      {
        env: {
          OPENAI_API_KEY: "status-env-key-placeholder",
          OPENAI_OAUTH_TOKEN: undefined,
        },
      },
    );
  });

  it("does not forward stale non-OpenAI profile overrides to Codex usage", async () => {
    registerStatusCodexHarness();
    providerUsageMock.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: Date.now(),
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          windows: [{ label: "5h", usedPercent: 9 }],
        },
      ],
    });

    await withTempHome(
      async (dir) => {
        saveStatusTestAuthProfiles({
          dir,
          profiles: [
            { profileId: "openai:status", provider: "openai" },
            { profileId: "anthropic:work", provider: "anthropic" },
          ],
        });

        await buildStatusText({
          cfg: {
            ...baseCfg,
            agents: {
              defaults: {
                models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
              },
            },
          },
          sessionEntry: {
            sessionId: "sess-status-codex-stale-profile",
            updatedAt: 0,
            authProfileOverride: "anthropic:work",
          },
          ...createStatusSessionParams(),
          provider: "openai",
          model: "gpt-5.5",
          contextTokens: 32_000,
          ...createStatusDisplayParams(),
        });

        const providerUsageCall = providerUsageMock.loadProviderUsageSummary.mock.calls.find(
          ([params]) => params?.providers?.includes("openai"),
        );
        expect(providerUsageCall?.[0]?.auth).toEqual(expectedCodexRuntimeUsageAuth);
      },
      { skipSessionCleanup: true, skipHomeCleanup: true },
    );
  });

  it("uses the session-selected provider for /status usage when runtime state is stale", async () => {
    const usageResetBase = Math.floor(Date.now() / 1000);
    providerUsageMock.loadProviderUsageSummary.mockImplementation(
      async ({ providers = [] } = {}) => ({
        updatedAt: Date.now(),
        providers: providers.map((provider) =>
          provider === "openai"
            ? {
                provider: "openai",
                displayName: "OpenAI",
                windows: [
                  {
                    label: "5h",
                    usedPercent: 9,
                    resetAt: (usageResetBase + 60 * 60) * 1000,
                  },
                ],
              }
            : {
                provider,
                displayName: "DeepSeek",
                windows: [],
                summary: "Balance ¥42.50",
              },
        ),
      }),
    );

    const text = await buildStatusText({
      cfg: {
        ...baseCfg,
        agents: {
          defaults: {
            model: "deepseek/deepseek-v4-flash",
          },
        },
      },
      sessionEntry: {
        sessionId: "sess-status-stale-runtime-selected-usage",
        updatedAt: 0,
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        modelOverrideSource: "user",
        modelProvider: "deepseek",
        model: "deepseek-v4-flash",
      },
      ...createStatusSessionParams("telegram"),
      provider: "deepseek",
      model: "deepseek-v4-flash",
      contextTokens: 1_000_000,
      ...createStatusDisplayParams(),
      modelAuthOverride: "oauth (openai:status)",
      activeModelAuthOverride: "api-key",
    });

    const normalized = normalizeTestText(text);
    expect(normalized).toContain("Model: openai/gpt-5.5");
    expect(normalized).toContain("pinned session; config primary deepseek/deepseek-v4-flash");
    expect(normalized).toContain("clear /model default");
    expect(normalized).toContain("Usage: 5h 91% left");
    expect(normalized).not.toContain("Usage: Balance ¥42.50");
    expect(providerUsageMock.loadProviderUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({ providers: ["openai"] }),
    );
  });

  it("uses provider-qualified model overrides for /status usage lookup", async () => {
    await withTempHome(
      async (dir) => {
        saveStatusTestAuthProfile({ dir, profileId: "openai:status", provider: "openai" });

        const usageResetBase = Math.floor(Date.now() / 1000);
        providerUsageMock.loadProviderUsageSummary.mockImplementation(
          async ({ providers = [] } = {}) => ({
            updatedAt: Date.now(),
            providers: providers.map((provider) =>
              provider === "openai"
                ? {
                    provider: "openai",
                    displayName: "OpenAI",
                    windows: [
                      {
                        label: "5h",
                        usedPercent: 9,
                        resetAt: (usageResetBase + 60 * 60) * 1000,
                      },
                    ],
                  }
                : {
                    provider,
                    displayName: "DeepSeek",
                    windows: [],
                    summary: "Balance ¥42.50",
                  },
            ),
          }),
        );

        const text = await buildStatusText({
          cfg: {
            ...baseCfg,
            models: {
              providers: {
                openai: {
                  baseUrl: "https://chatgpt.com/backend-api/codex",
                  models: [{ ...codexStatusModel, contextWindow: 258_000, contextTokens: 258_000 }],
                },
              },
            },
            agents: {
              defaults: {
                model: "deepseek/deepseek-v4-flash",
              },
            },
            auth: {
              order: {
                openai: ["openai:status"],
              },
            },
          },
          sessionEntry: {
            sessionId: "sess-status-qualified-session-selected-usage",
            updatedAt: 0,
            modelOverride: "openai/gpt-5.5",
          },
          ...createStatusSessionParams("telegram"),
          provider: "deepseek",
          model: "deepseek-v4-flash",
          contextTokens: 1_000_000,
          ...createStatusDisplayParams(),
        });

        const normalized = normalizeTestText(text);
        expect(normalized).toContain("Model: openai/gpt-5.5");
        expect(normalized).toContain("pinned session; config primary deepseek/deepseek-v4-flash");
        expect(normalized).toContain("clear /model default");
        expect(normalized).toContain("oauth (openai:status)");
        expect(normalized).toContain("Context: ?/258k");
        expect(normalized).toContain("Usage: 5h 91% left");
        expect(normalized).not.toContain("Usage: Balance ¥42.50");
        expect(providerUsageMock.loadProviderUsageSummary).toHaveBeenCalledWith(
          expect.objectContaining({ providers: ["openai"] }),
        );
      },
      { env: { OPENAI_API_KEY: undefined } },
    );
  });

  it("clamps off to the active provider's always-thinking level", async () => {
    activeProviderThinkingMock.resolveThinkingProfile.mockReturnValue({
      levels: [{ id: "max", label: "max" }],
      defaultLevel: "max",
    });

    const text = await buildStatusText({
      cfg: baseCfg,
      sessionEntry: {
        sessionId: "sess-status-kimi-k3",
        updatedAt: 0,
        thinkingLevel: "off",
      },
      ...createStatusSessionParams(),
      provider: "moonshot",
      model: "kimi-k3",
      contextTokens: 262_144,
      resolvedThinkLevel: "off",
      ...createStatusDisplayParams(),
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
    });

    expect(normalizeTestText(text)).toContain("think max");
    expect(activeProviderThinkingMock.resolveThinkingProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "moonshot",
        context: expect.objectContaining({ modelId: "kimi-k3" }),
      }),
    );
  });
});

describe("buildStatusReply error handling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("delivers a fixed generic reply and logs details when status rendering throws", async () => {
    const logError = vi.spyOn(logger, "logError").mockImplementation(() => {});
    vi.spyOn(statusText, "buildStatusReplyParts").mockRejectedValue(
      new Error("Unexpected rendering error"),
    );
    const reply = await buildStatusReplyForTest({});

    // Exact object equality also pins that no stale presentation or internal
    // error text reaches the channel; diagnostics belong to the log sink only.
    expect(reply).toEqual({ text: "⚠️ Status: error rendering response" });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("Unexpected rendering error"));
  });

  it("returns a generic reply and logs details when plugin health collection fails", async () => {
    const logError = vi.spyOn(logger, "logError").mockImplementation(() => {});
    pluginHealthRuntimeMock.collectInstalledPluginHealthSnapshot.mockRejectedValueOnce(
      new Error("Cannot find module 'internal/path'"),
    );

    const commandParams = buildCommandTestParams("/status plugins", {
      ...baseCfg,
      commands: { text: true, plugins: true },
    });
    const reply = await buildStatusPluginsReply({
      cfg: commandParams.cfg,
      command: commandParams.command,
      workspaceDir: commandParams.workspaceDir,
    });

    expect(reply?.text).toBe("⚠️ Plugins: health unavailable");
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("Cannot find module 'internal/path'"),
    );
  });
});
describe("buildStatusReply", () => {
  beforeAll(async () => {
    await buildKiraStatusReply({
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
        },
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig);
  });

  it("shows per-agent thinkingDefault in the status card", async () => {
    const cfg = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: "openai/gpt-5.4",
        },
        entries: {
          kira: {
            model: "openai/gpt-5.4",
            thinkingDefault: "xhigh",
          },
        },
      },
      channels: {
        whatsapp: { allowFrom: ["*"] },
      },
    } as OpenClawConfig;

    const reply = await buildKiraStatusReply(cfg);

    expect(reply?.text).toContain("think xhigh");
  });
});
