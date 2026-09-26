// Tests which usage line /status shows for sessions running on Claude Code.
import fs from "node:fs";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeTestText } from "../../../test/helpers/normalize-text.js";
import { saveAuthProfileStore } from "../../agents/auth-profiles/store-runtime.js";
import { testing as cliBackendsTesting } from "../../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  clearObservedProviderUsageWindows,
  noteClaudeCodeSessionRoute,
  recordObservedProviderUsageWindows,
} from "../../infra/provider-usage.observed.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { buildStatusText } from "./commands-status.js";
import {
  baseCommandTestConfig,
  configureInMemoryTaskRegistryStoreForTests,
} from "./commands.test-harness.js";

type LoadProviderUsageSummary =
  typeof import("../../infra/provider-usage.js").loadProviderUsageSummary;

const providerUsageMock = vi.hoisted(() => ({
  loadProviderUsageSummary: vi.fn<LoadProviderUsageSummary>(),
}));

vi.mock("../../infra/provider-usage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/provider-usage.js")>()),
  loadProviderUsageSummary: providerUsageMock.loadProviderUsageSummary,
}));

vi.mock("../../status/status-plugin-health.runtime.js", () => {
  const empty = () => ({
    plugins: [],
    diagnostics: [],
    contextEngineQuarantines: [],
    runtimeToolQuarantines: [],
    channelPluginFailures: [],
  });
  return {
    collectInstalledPluginHealthSnapshot: vi.fn(async () => empty()),
    collectRuntimePluginHealthSnapshot: vi.fn(() => empty()),
  };
});

const claudeCliCfg = {
  ...baseCommandTestConfig,
  agents: { defaults: { agentRuntime: { id: "claude-cli" } } },
} as OpenClawConfig;
const env = { ANTHROPIC_API_KEY: undefined, ANTHROPIC_OAUTH_TOKEN: undefined };

function buildClaudeCliStatus(sessionEntry: SessionEntry, cfg: OpenClawConfig = claudeCliCfg) {
  return buildStatusText({
    cfg,
    sessionEntry,
    sessionKey: "agent:main:main",
    parentSessionKey: "agent:main:main",
    sessionScope: "per-sender",
    statusChannel: "mobilechat",
    provider: "anthropic",
    model: "claude-opus-4-7",
    contextTokens: 32_000,
    resolvedHarness: "claude-cli",
    resolvedFastMode: false,
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
    defaultGroupActivation: () => "mention",
  });
}

describe("/status usage for Claude Code sessions", () => {
  beforeEach(() => {
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
    resetTaskRegistryForTests({ persist: false });
    configureInMemoryTaskRegistryStoreForTests();
    providerUsageMock.loadProviderUsageSummary.mockResolvedValue({
      updatedAt: Date.now(),
      providers: [],
    });
    recordObservedProviderUsageWindows("claude-cli", [
      { label: "5h", usedPercent: 20, resetAt: Date.now() + 60 * 60_000 },
    ]);
    // The session's latest Claude Code turn ran on the host login.
    noteClaudeCodeSessionRoute("agent:main:main", true);
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
    providerUsageMock.loadProviderUsageSummary.mockReset();
    clearObservedProviderUsageWindows();
  });

  it("shows the windows Claude Code reported for a session on the host login", async () => {
    await withTempHome(
      async () => {
        const text = normalizeTestText(
          await buildClaudeCliStatus({ sessionId: "sess-claude-code-host", updatedAt: 0 }),
        );
        expect(text).toContain("native (claude-cli)");
        expect(text).toMatch(/Usage: 5h 80% left/);
        // No usage request can reach Claude Code's own login.
        expect(providerUsageMock.loadProviderUsageSummary).not.toHaveBeenCalled();
      },
      { env },
    );
  });

  it("keeps them off a session whose latest turn the runner kept off the host login", async () => {
    // For example a backend credential, settings file, or config directory.
    noteClaudeCodeSessionRoute("agent:main:main", false);
    await withTempHome(
      async () => {
        const text = normalizeTestText(
          await buildClaudeCliStatus({ sessionId: "sess-claude-code-backend", updatedAt: 0 }),
        );
        expect(text).toContain("native (claude-cli)");
        expect(text).not.toMatch(/80% left/);
      },
      { env },
    );
  });

  it("keeps them off a session whose configured model pins an API key", async () => {
    await withTempHome(
      async (dir) => {
        const agentDir = path.join(dir, ".openclaw", "agents", "main", "agent");
        fs.mkdirSync(agentDir, { recursive: true });
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              "anthropic:api": { type: "api_key", provider: "anthropic", key: "sk-ant-api03-x" },
            },
          },
          agentDir,
          { filterExternalAuthProfiles: false, syncExternalCli: false },
        );
        const cfg = {
          ...claudeCliCfg,
          agents: {
            defaults: {
              agentRuntime: { id: "claude-cli" },
              model: { primary: "anthropic/claude-opus-4-7@anthropic:api" },
            },
          },
        } as OpenClawConfig;
        const text = normalizeTestText(
          await buildClaudeCliStatus(
            { sessionId: "sess-claude-code-configured", updatedAt: 0 },
            cfg,
          ),
        );
        expect(text).not.toMatch(/80% left/);
      },
      { env },
    );
  });

  it("keeps them off a session whose run uses a stored Claude credential", async () => {
    await withTempHome(
      async (dir) => {
        const agentDir = path.join(dir, ".openclaw", "agents", "main", "agent");
        fs.mkdirSync(agentDir, { recursive: true });
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              "anthropic:work": {
                type: "token",
                provider: "anthropic",
                token: "sk-ant-oat01-work",
              },
            },
          },
          agentDir,
          { filterExternalAuthProfiles: false, syncExternalCli: false },
        );
        const resetAt = Date.now() + 60 * 60_000;
        providerUsageMock.loadProviderUsageSummary.mockResolvedValue({
          updatedAt: Date.now(),
          providers: [
            {
              provider: "claude-cli",
              displayName: "Claude Code",
              windows: [{ label: "5h", usedPercent: 20, resetAt }],
              observedAt: Date.now(),
            },
            {
              provider: "anthropic",
              displayName: "Claude",
              windows: [{ label: "5h", usedPercent: 70, resetAt }],
            },
          ],
        });
        const text = normalizeTestText(
          await buildClaudeCliStatus({ sessionId: "sess-claude-code-profile", updatedAt: 0 }),
        );
        expect(text).toContain("token (anthropic:work)");
        expect(text).toMatch(/Usage: 5h 30% left/);
        expect(text).not.toMatch(/80% left/);
      },
      { env },
    );
  });
});
