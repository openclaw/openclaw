import fs from "node:fs";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { saveAuthProfileStore } from "../../agents/auth-profiles/store-runtime.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import { clearAgentHarnesses, registerAgentHarness } from "../../agents/harness/registry.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import {
  seedSubagentRunForReadTest,
  resetSubagentRegistryForTests,
} from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import * as logger from "../../logger.js";
import * as statusText from "../../status/status-text.js";
import { buildStatusPluginsReply, buildStatusText } from "./commands-status.js";
import { buildKiraStatusReply, buildStatusReplyForTest } from "./commands-status.test-support.js";
import { baseCommandTestConfig, buildCommandTestParams } from "./commands.test-harness.js";

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
    typeof import("../../plugins/provider-thinking-active.js").resolveActiveProviderThinkingProfile
  >(() => undefined),
}));
type StatusPluginHealthSnapshot =
  import("../../status/status-plugin-health.js").StatusPluginHealthSnapshot;

const pluginHealthRuntimeMock = vi.hoisted(() => {
  const emptySnapshot = (): StatusPluginHealthSnapshot => ({
    plugins: [],
    diagnostics: [],
    contextEngineQuarantines: [],
    runtimeToolQuarantines: [],
    channelPluginFailures: [],
  });
  return {
    emptySnapshot,
    collectInstalledPluginHealthSnapshot: vi.fn(async () => emptySnapshot()),
    collectRuntimePluginHealthSnapshot: vi.fn(emptySnapshot),
  };
});

vi.mock("../../infra/provider-usage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/provider-usage.js")>()),
  loadProviderUsageSummary: providerUsageMock.loadProviderUsageSummary,
}));

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
  { provider: "openai", token: "codex-app-server", hookProvider: "codex" },
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

const statusDefaults = {
  cfg: baseCfg,
  sessionEntry: { sessionId: "status-session", updatedAt: 0 },
  provider: "openai",
  model: "gpt-5.5",
  contextTokens: 32_000,
  sessionKey: "agent:main:main",
  parentSessionKey: "agent:main:main",
  sessionScope: "per-sender",
  statusChannel: "mobilechat",
  resolvedFastMode: false,
  resolvedVerboseLevel: "off",
  resolvedReasoningLevel: "off",
  resolveDefaultThinkingLevel: async () => undefined,
  isGroup: false,
  defaultGroupActivation: () => "mention",
} satisfies Partial<StatusTextParams>;

async function renderStatus(params: Partial<StatusTextParams>) {
  return normalizeTestText(await buildStatusText({ ...statusDefaults, ...params }));
}

function expectText(text: string, includes: string[], excludes: string[] = []) {
  for (const part of includes) {
    expect(text).toContain(part);
  }
  for (const part of excludes) {
    expect(text).not.toContain(part);
  }
}

function expectSelectedUsage(text: string, extra: string[] = []) {
  expectText(
    text,
    [
      "Model: openai/gpt-5.5",
      "pinned session; config primary deepseek/deepseek-v4-flash",
      "clear /model default",
      "Usage: 5h 91% left",
      ...extra,
    ],
    ["Usage: Balance ¥42.50"],
  );
  expect(providerUsageMock.loadProviderUsageSummary).toHaveBeenCalledWith(
    expect.objectContaining({ providers: ["openai"] }),
  );
}

function pluginsReply(enabled: boolean) {
  return buildStatusPluginsReply(
    buildCommandTestParams("/status plugins", {
      ...baseCfg,
      commands: { text: true, plugins: enabled },
    }),
  );
}

const codexRuntimeConfig = {
  ...baseCfg,
  agents: { defaults: { models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } } },
} satisfies OpenClawConfig;
const deepseekConfig = {
  ...baseCfg,
  agents: { defaults: { model: "deepseek/deepseek-v4-flash" } },
} satisfies OpenClawConfig;
const kiraConfig = {
  session: { mainKey: "main", scope: "per-sender" },
  agents: { defaults: { model: "openai/gpt-5.4" } },
  channels: { whatsapp: { allowFrom: ["*"] } },
} satisfies OpenClawConfig;

function mockSelectedProviderUsage() {
  const resetAt = (Math.floor(Date.now() / 1000) + 60 * 60) * 1000;
  providerUsageMock.loadProviderUsageSummary.mockImplementation(
    async ({ providers = [] } = {}) => ({
      updatedAt: Date.now(),
      providers: providers.map((provider) =>
        provider === "openai"
          ? { provider, displayName: "OpenAI", windows: [{ label: "5h", usedPercent: 9, resetAt }] }
          : { provider, displayName: "DeepSeek", windows: [], summary: "Balance ¥42.50" },
      ),
    }),
  );
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

function saveStatusTestAuthProfiles(dir: string, includeAnthropic = false): void {
  const agentDir = path.join(dir, ".openclaw", "agents", "main", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  saveAuthProfileStore(
    {
      version: 1,
      profiles: {
        "openai:status": {
          type: "oauth",
          provider: "openai",
          access: "access-token",
          refresh: "refresh-token",
          expires: Date.now() + 60 * 60_000,
        },
        ...(includeAnthropic
          ? {
              "anthropic:work": {
                type: "api_key",
                provider: "anthropic",
                key: "anthropic-api-key",
              } satisfies AuthProfileCredential,
            }
          : {}),
      },
    },
    agentDir,
    { filterExternalAuthProfiles: false, syncExternalCli: false },
  );
}

afterEach(() => {
  clearRuntimeConfigSnapshot();
  cliBackendsTesting.resetDepsForTest();
  clearAgentHarnesses();
  providerUsageMock.loadProviderUsageSummary.mockReset().mockResolvedValue({
    updatedAt: Date.now(),
    providers: [],
  });
  activeProviderThinkingMock.resolveThinkingProfile.mockReset().mockReturnValue(undefined);
  pluginHealthRuntimeMock.collectInstalledPluginHealthSnapshot
    .mockReset()
    .mockImplementation(async () => pluginHealthRuntimeMock.emptySnapshot());
  pluginHealthRuntimeMock.collectRuntimePluginHealthSnapshot
    .mockReset()
    .mockImplementation(pluginHealthRuntimeMock.emptySnapshot);
});

describe("buildStatusReply subagent summary", () => {
  beforeEach(async () => {
    setRuntimeConfigSnapshot(baseCfg);
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
      task: "status orchestrator",
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
      createdAt: Date.now() - 60_000,
      startedAt: Date.now() - 60_000,
    });

    const reply = await buildStatusReplyForTest({});

    expect(reply?.text).toContain("🤖 Subagents: 1 active");
  });

  it("gates /status plugins behind the plugin command flag", async () => {
    const reply = await pluginsReply(false);

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
            tokens: { access_token: "codex-access-token", refresh_token: "codex-refresh-token" },
          }),
          "utf-8",
        );

        const text = await renderStatus({ cfg: codexRuntimeConfig });
        expectText(
          text,
          ["Model: openai/gpt-5.5", "Runtime: OpenAI Codex", "api-key (env: OPENAI_API_KEY)"],
          ["oauth (codex-cli)"],
        );
      },
      { env: { OPENAI_API_KEY: "status-env-key-placeholder", OPENAI_OAUTH_TOKEN: undefined } },
    );
  });

  it("does not forward stale non-OpenAI profile overrides to Codex usage", async () => {
    registerStatusCodexHarness();
    providerUsageMock.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: Date.now(),
      providers: [
        { provider: "openai", displayName: "OpenAI", windows: [{ label: "5h", usedPercent: 9 }] },
      ],
    });

    await withTempHome(
      async (dir) => {
        saveStatusTestAuthProfiles(dir, true);

        await renderStatus({
          cfg: codexRuntimeConfig,
          sessionEntry: {
            ...statusDefaults.sessionEntry,
            authProfileOverride: "anthropic:work",
          },
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
    mockSelectedProviderUsage();

    const text = await renderStatus({
      cfg: deepseekConfig,
      sessionEntry: {
        sessionId: "sess-status-stale-runtime-selected-usage",
        updatedAt: 0,
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        modelOverrideSource: "user",
        modelProvider: "deepseek",
        model: "deepseek-v4-flash",
      },
      statusChannel: "telegram",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      contextTokens: 1_000_000,
      modelAuthOverride: "oauth (openai:status)",
      activeModelAuthOverride: "api-key",
    });

    expectSelectedUsage(text);
  });

  it("uses provider-qualified model overrides for /status usage lookup", async () => {
    await withTempHome(
      async (dir) => {
        saveStatusTestAuthProfiles(dir);
        mockSelectedProviderUsage();
        const text = await renderStatus({
          cfg: {
            ...deepseekConfig,
            models: {
              providers: {
                openai: {
                  baseUrl: "https://chatgpt.com/backend-api/codex",
                  models: [{ ...codexStatusModel, contextWindow: 258_000, contextTokens: 258_000 }],
                },
              },
            },
            auth: { order: { openai: ["openai:status"] } },
          },
          sessionEntry: {
            sessionId: "sess-status-qualified-session-selected-usage",
            updatedAt: 0,
            modelOverride: "openai/gpt-5.5",
          },
          statusChannel: "telegram",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          contextTokens: 1_000_000,
        });

        expectSelectedUsage(text, ["oauth (openai:status)", "Context: ?/258k"]);
      },
      { env: { OPENAI_API_KEY: undefined } },
    );
  });

  it("clamps off to the active provider's always-thinking level", async () => {
    activeProviderThinkingMock.resolveThinkingProfile.mockReturnValue({
      levels: [{ id: "max", label: "max" }],
      defaultLevel: "max",
    });

    const text = await renderStatus({
      sessionEntry: {
        sessionId: "sess-status-kimi-k3",
        updatedAt: 0,
        thinkingLevel: "off",
      },
      provider: "moonshot",
      model: "kimi-k3",
      contextTokens: 262_144,
      resolvedThinkLevel: "off",
      modelAuthOverride: "api-key",
      activeModelAuthOverride: "api-key",
    });

    expect(text).toContain("think max");
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

    expect(reply).toEqual({ text: "⚠️ Status: error rendering response" });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("Unexpected rendering error"));
  });

  it("returns a generic reply and logs details when plugin health collection fails", async () => {
    const logError = vi.spyOn(logger, "logError").mockImplementation(() => {});
    pluginHealthRuntimeMock.collectInstalledPluginHealthSnapshot.mockRejectedValueOnce(
      new Error("Cannot find module 'internal/path'"),
    );

    const reply = await pluginsReply(true);

    expect(reply?.text).toBe("⚠️ Plugins: health unavailable");
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining("Cannot find module 'internal/path'"),
    );
  });
});
it("shows per-agent thinkingDefault in the status card", async () => {
  await buildKiraStatusReply(kiraConfig);
  const cfg = {
    ...kiraConfig,
    agents: {
      ...kiraConfig.agents,
      entries: {
        kira: { model: "openai/gpt-5.4", thinkingDefault: "xhigh" },
      },
    },
  } satisfies OpenClawConfig;

  const reply = await buildKiraStatusReply(cfg);
  expect(reply?.text).toContain("think xhigh");
});
