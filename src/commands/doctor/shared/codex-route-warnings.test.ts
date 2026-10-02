import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { resolveAgentHarnessPolicy } from "../../../agents/harness/policy.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn().mockReturnValue({ profiles: {}, usageStats: {} }),
  evaluateStoredCredentialEligibility: vi
    .fn()
    .mockReturnValue({ eligible: true, reasonCode: "ok" }),
  isInstalledPluginEnabled: vi.fn().mockReturnValue(false),
  loadInstalledPluginIndex: vi.fn().mockReturnValue({ plugins: [] }),
  resolveAuthProfileOrder: vi.fn().mockReturnValue([]),
  resolveProfileUnusableUntilForDisplay: vi.fn().mockReturnValue(null),
}));

vi.mock("../../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mocks.ensureAuthProfileStore,
  resolveAuthProfileOrder: mocks.resolveAuthProfileOrder,
  resolveProfileUnusableUntilForDisplay: mocks.resolveProfileUnusableUntilForDisplay,
}));

vi.mock("../../../agents/auth-profiles/credential-state.js", () => ({
  evaluateStoredCredentialEligibility: mocks.evaluateStoredCredentialEligibility,
}));

vi.mock("../../../plugins/installed-plugin-index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/installed-plugin-index.js")>()),
  isInstalledPluginEnabled: mocks.isInstalledPluginEnabled,
  loadInstalledPluginIndex: mocks.loadInstalledPluginIndex,
}));

import { legacyCodexProviderIdentityKey } from "./codex-route-model-ref.js";
import { repairCodexSessionStoreRoutes } from "./codex-route-session-repair.test-support.js";
import {
  collectCodexRouteWarnings as collectCodexRouteWarningsUnderTest,
  maybeRepairCodexRoutes as maybeRepairCodexRoutesUnderTest,
} from "./codex-route-warnings.js";
import { collectBlockedLegacyOpenAICodexProviderPlan } from "./legacy-config-migrations.runtime.models.js";

const REPAIRABLE_CODEX_PLUGIN_CONFIG = { allow: ["openai"] };
const DISABLED_CODEX_PLUGIN_CONFIG = { entries: { codex: { enabled: false } } };
const CODEX_PLUGIN_REPAIR_CHANGES = [
  "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
  "Added codex to plugins.allow because configured agent routes use Codex runtime.",
];
const CODEX_COMPACTION_REPAIR_CHANGES = [
  "Removed agents.defaults.compaction.model; Codex runtime uses native server-side compaction.",
  "Removed agents.defaults.compaction.provider; Codex runtime uses native server-side compaction.",
];

type CodexRouteWarningOptions = Omit<
  Parameters<typeof collectCodexRouteWarningsUnderTest>[0],
  "cfg"
>;
type CodexRouteRepairOptions = Omit<
  Parameters<typeof maybeRepairCodexRoutesUnderTest>[0],
  "cfg" | "shouldRepair"
>;

// These fixtures intentionally exercise raw legacy shapes that current config validation rejects.
const asLegacyConfig = (cfg: unknown): OpenClawConfig => cfg as OpenClawConfig;

function collectCodexRouteWarnings(cfg: unknown, options: CodexRouteWarningOptions = {}): string[] {
  return collectCodexRouteWarningsUnderTest({ cfg: asLegacyConfig(cfg), ...options });
}

function maybeRepairCodexRoutes(cfg: unknown, options: CodexRouteRepairOptions = {}) {
  return maybeRepairCodexRoutesUnderTest({
    cfg: asLegacyConfig(cfg),
    shouldRepair: true,
    ...options,
  });
}

function repairDefaultAgent(defaults: unknown) {
  return maybeRepairCodexRoutes({ agents: { defaults } });
}

type CodexRouteRepairResult = ReturnType<typeof maybeRepairCodexRoutes>;
type AgentRuntime = ReturnType<typeof resolveAgentHarnessPolicy>["runtime"];

function expectAgentRuntime(
  config: OpenClawConfig,
  expected: AgentRuntime,
  options: { provider?: string; modelId?: string; agentId?: string } = {},
) {
  expect(
    resolveAgentHarnessPolicy({
      provider: options.provider ?? "openai",
      modelId: options.modelId ?? "gpt-5.4",
      agentId: options.agentId,
      config,
    }).runtime,
  ).toBe(expected);
}

function expectCodexPluginEnabled(result: CodexRouteRepairResult) {
  expect(result.warnings).toStrictEqual([]);
  expect(result.changes).toStrictEqual(CODEX_PLUGIN_REPAIR_CHANGES);
  expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
}

function expectCodexPluginDisabled(result: CodexRouteRepairResult) {
  expect(result.warnings).toStrictEqual([]);
  expect(result.changes).toStrictEqual([]);
  expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
}

function itReenablesCodexPlugin(title: string, cfg: Record<string, unknown>) {
  it(title, () => {
    expectCodexPluginEnabled(
      maybeRepairCodexRoutes({ plugins: REPAIRABLE_CODEX_PLUGIN_CONFIG, ...cfg }),
    );
  });
}

function itKeepsCodexPluginDisabled(title: string, cfg: Record<string, unknown>) {
  it(title, () => {
    expectCodexPluginDisabled(
      maybeRepairCodexRoutes({ plugins: DISABLED_CODEX_PLUGIN_CONFIG, ...cfg }),
    );
  });
}

function getSession(store: Record<string, SessionEntry>, key: string): SessionEntry {
  return expectDefined(store[key], `store.${key} test invariant`);
}

function legacyRouteWarning(...routes: string[]): string {
  return [
    "- Legacy `codex/*` and `openai-codex/*` model refs should be rewritten to `openai/*`.",
    ...routes,
    "- Run `openclaw doctor --fix`: it rewrites configured model refs and stale sessions to `openai/*`, moves Codex intent to provider/model runtime policy, and clears old whole-agent runtime pins.",
  ].join("\n");
}

function disabledCodexPluginWarning(...routes: string[]): string {
  return [
    "- Codex runtime is selected, but the Codex plugin is disabled.",
    ...routes,
    "- Enable plugins.entries.codex and plugin loading, and remove `codex` from plugins.deny; or set the affected OpenAI models to an OpenClaw runtime policy.",
  ].join("\n");
}

function codexCompactionWarning(...details: string[]): string {
  return [
    "- Codex runtime uses native server-side compaction and ignores OpenClaw compaction summarizer overrides.",
    ...details,
  ].join("\n");
}

function losslessCompactionWarning(...routes: string[]): string {
  return [
    "- Legacy Lossless compaction config should use the Lossless context-engine slot for Codex.",
    ...routes,
    "- Move the Lossless config manually; doctor will not overwrite an existing non-Lossless context-engine slot or collapse conflicting per-agent summary models.",
  ].join("\n");
}

describe("collectCodexRouteWarnings", () => {
  it("surfaces enabled Codex Computer Use in doctor warnings", () => {
    const warnings = collectCodexRouteWarnings({
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              computerUse: {
                enabled: true,
                healthCheckEnabled: true,
                healthCheckIntervalMinutes: 120,
                autoRepair: true,
              },
            },
          },
        },
      },
    });

    expect(warnings).toStrictEqual([
      [
        "- Codex Computer Use is enabled.",
        "- Doctor config review found Computer Use enabled; run `/codex computer-use status` to inspect installation, exposure, and the live `list_apps` probe.",
        "- Periodic Computer Use health checks are enabled with a 120-minute cadence.",
        "- Stale Computer Use MCP child repair is enabled and limited to SkyComputerUseClient children.",
      ].join("\n"),
    ]);
  });

  it("surfaces opt-in defaults for Codex Computer Use health and repair", () => {
    const warnings = collectCodexRouteWarnings({
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: { computerUse: { enabled: true } },
          },
        },
      },
    });

    expect(warnings).toStrictEqual([
      [
        "- Codex Computer Use is enabled.",
        "- Doctor config review found Computer Use enabled; run `/codex computer-use status` to inspect installation, exposure, and the live `list_apps` probe.",
        "- Periodic Computer Use health checks are disabled by default; set `computerUse.healthCheckEnabled` to true to enable them.",
        "- Stale Computer Use MCP child repair is disabled by default; set `computerUse.autoRepair` to true to repair before retrying a failed probe.",
      ].join("\n"),
    ]);
  });

  it("repairs legacy openai-codex model refs found only in agents.list.*.models maps", () => {
    const result = maybeRepairCodexRoutes({
      agents: {
        list: [
          {
            id: "worker",
            model: "anthropic/claude-sonnet-4-6",
            models: { "openai-codex/gpt-5.4": { alias: "legacy" } },
          },
        ],
      },
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.cfg.agents?.list?.[0]?.models?.["openai/gpt-5.4"]?.alias).toBe("legacy");
    expect(result.cfg.agents?.list?.[0]?.models?.["openai/gpt-5.4"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(result.cfg.agents?.list?.[0]?.models?.["openai-codex/gpt-5.4"]).toBeUndefined();
  });

  it("repairs only redundant native Codex service tiers and is idempotent", () => {
    const command = "node -e process.exit(99)";
    const original = {
      plugins: { entries: { codex: { enabled: true, config: { appServer: { command } } } } },
      agents: {
        defaults: {
          params: { temperature: 0.7 },
          models: {
            "openai/gpt-5.6-sol": {
              params: { fastMode: true, serviceTier: "priority", temperature: 0.2 },
              agentRuntime: { id: "codex" },
            },
            "openai/gpt-5.6-terra": {
              params: { fast_mode: "on", service_tier: "PRIORITY" },
              agentRuntime: { id: "codex" },
            },
          },
        },
      },
    };

    const repaired = maybeRepairCodexRoutes(original);

    expect(repaired.changes).toStrictEqual([
      "Removed redundant agents.defaults.models.openai/gpt-5.6-sol.params.serviceTier; fastMode already selects native priority.",
      "Removed redundant agents.defaults.models.openai/gpt-5.6-terra.params.service_tier; fastMode already selects native priority.",
    ]);
    expect(repaired.cfg.agents?.defaults?.models).toEqual({
      "openai/gpt-5.6-sol": {
        params: { fastMode: true, temperature: 0.2 },
        agentRuntime: { id: "codex" },
      },
      "openai/gpt-5.6-terra": {
        params: { fast_mode: "on" },
        agentRuntime: { id: "codex" },
      },
    });
    expect(repaired.cfg.plugins?.entries?.codex?.config).toEqual({
      appServer: { command },
    });
    expect(repaired.warnings.join("\n")).toContain(
      "Custom Codex app-server command bypasses OpenClaw's managed exact-version binary.",
    );
    expect(repaired.warnings.join("\n")).toContain("agents.defaults.params.temperature");
    expect(repaired.warnings.join("\n")).toContain(
      "agents.defaults.models.openai/gpt-5.6-sol.params.temperature",
    );
    expect(original.agents.defaults.models["openai/gpt-5.6-sol"].params).toHaveProperty(
      "serviceTier",
    );

    const second = maybeRepairCodexRoutes(repaired.cfg);
    expect(second.cfg).toBe(repaired.cfg);
    expect(second.changes).toStrictEqual([]);
    expect(second.warnings).toStrictEqual(repaired.warnings);
  });

  it("preserves and reports authored params across effective Codex sources", () => {
    const original = {
      agents: {
        defaults: {
          model: "openai/gpt-5.6-sol",
          params: { temperature: 0.7 },
          models: {
            "openai/gpt-5.6-sol": {
              params: {
                fastMode: true,
                fast_mode: false,
                serviceTier: "priority",
                temperature: 0.2,
              },
              agentRuntime: { id: "codex" },
            },
            "openai/gpt-5.6-openclaw": {
              params: { fastMode: true, serviceTier: "priority" },
              agentRuntime: { id: "openclaw" },
            },
          },
        },
        entries: {
          coder: { params: { topP: 0.8 } },
          worker: {
            models: {
              "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      },
    };

    const result = maybeRepairCodexRoutes(original);

    expect(result.cfg).toBe(original);
    expect(result.changes).toStrictEqual([]);
    expect(result.warnings.join("\n")).toContain(
      "agents.defaults.models.openai/gpt-5.6-sol.params.serviceTier",
    );
    expect(result.warnings.join("\n")).toContain(
      "agents.defaults.models.openai/gpt-5.6-sol.params.temperature",
    );
    expect(result.warnings.join("\n")).toContain("agents.defaults.params.temperature");
    expect(result.warnings.join("\n")).toContain("agents.entries.coder.params.topP");
    expect(result.warnings.join("\n")).not.toContain("gpt-5.6-openclaw.params.serviceTier");
  });

  it("uses the doctor environment snapshot for implicit OpenAI routing", () => {
    const cfg = {
      plugins: DISABLED_CODEX_PLUGIN_CONFIG,
      agents: { defaults: { model: { primary: "openai/gpt-5.4-nano" } } },
    } as unknown as OpenClawConfig;

    expect(
      collectCodexRouteWarnings(cfg, {
        env: { OPENAI_BASE_URL: "https://proxy.example.invalid/v1" },
      }),
    ).toStrictEqual([]);
    expect(
      collectCodexRouteWarnings(cfg, {
        env: { OPENAI_BASE_URL: "https://chatgpt.com/backend-api/codex" },
      }),
    ).toStrictEqual([
      disabledCodexPluginWarning(
        "- agents.defaults.model.primary: openai/gpt-5.4-nano resolves to openai/gpt-5.4-nano with Codex runtime while the Codex plugin is disabled by config.",
      ),
    ]);
  });

  it("does not migrate mixed Lossless provider-only and summary-model consumers", () => {
    const result = maybeRepairCodexRoutes({
      agents: {
        defaults: { model: "openai/gpt-5.5", compaction: { provider: "lossless-claw" } },
        list: [
          { id: "fast", model: "openai/gpt-5.5", compaction: { model: "openai/gpt-5.4-mini" } },
        ],
      },
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins).toBeUndefined();
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      provider: "lossless-claw",
    });
    expect(result.cfg.agents?.list?.[0]?.compaction).toEqual({
      model: "openai/gpt-5.4-mini",
    });
    expect(result.warnings).toStrictEqual([
      losslessCompactionWarning(
        "- agents.defaults.compaction.provider: lossless-claw should become plugins.slots.contextEngine: lossless-claw.",
        "- agents.list.fast.compaction.model: openai/gpt-5.4-mini should become plugins.entries.lossless-claw.config.summaryModel.",
      ),
    ]);
  });

  it("canonicalizes bare legacy Lossless summary models during migration", () => {
    const result = repairDefaultAgent({
      model: "openai/gpt-5.5",
      compaction: { model: "gpt-5.4-mini", provider: "lossless-claw" },
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.["lossless-claw"]).toEqual({
      enabled: true,
      config: { summaryModel: "openai/gpt-5.4-mini" },
      llm: {
        allowModelOverride: true,
        allowedModels: ["openai/gpt-5.4-mini"],
      },
    });
    expect(result.cfg.agents?.defaults?.compaction).toBeUndefined();
  });

  it("does not grant Lossless model override policy without a migrated summary model", () => {
    const result = repairDefaultAgent({
      model: "openai/gpt-5.5",
      compaction: {
        provider: "lossless-claw",
        keepRecentTokens: 10_000,
      },
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.cfg.plugins?.slots?.contextEngine).toBe("lossless-claw");
    expect(result.cfg.plugins?.entries?.["lossless-claw"]).toEqual({
      enabled: true,
      config: {},
    });
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      keepRecentTokens: 10_000,
    });
  });

  it("migrates numeric string agent ids before treating the path label as an index", () => {
    const result = maybeRepairCodexRoutes({
      agents: {
        list: [
          { id: "other", model: "anthropic/claude-sonnet-4-6" },
          {
            id: "0",
            model: "openai/gpt-5.5",
            compaction: { model: "openai/gpt-5.4-mini", provider: "lossless-claw" },
          },
        ],
      },
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.cfg.agents?.list?.[0]?.compaction).toBeUndefined();
    expect(result.cfg.agents?.list?.[1]?.compaction).toBeUndefined();
    expect(result.cfg.plugins?.entries?.["lossless-claw"]?.config).toEqual({
      summaryModel: "openai/gpt-5.4-mini",
    });
  });

  it("does not collapse conflicting per-agent Lossless summary models", () => {
    const result = maybeRepairCodexRoutes({
      agents: {
        list: [
          {
            id: "fast",
            model: "openai/gpt-5.5",
            compaction: { model: "openai/gpt-5.4-mini", provider: "lossless-claw" },
          },
          {
            id: "deep",
            model: "openai/gpt-5.5",
            compaction: { model: "openai/gpt-5.5", provider: "lossless-claw" },
          },
        ],
      },
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins).toBeUndefined();
    expect(result.cfg.agents?.list?.[0]?.compaction).toEqual({
      model: "openai/gpt-5.4-mini",
      provider: "lossless-claw",
    });
    expect(result.cfg.agents?.list?.[1]?.compaction).toEqual({
      model: "openai/gpt-5.5",
      provider: "lossless-claw",
    });
  });

  it("does not overwrite a non-Lossless context-engine slot", () => {
    const result = maybeRepairCodexRoutes({
      plugins: { slots: { contextEngine: "custom-context" } },
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          compaction: {
            model: "openai-codex/gpt-5.4",
            provider: "lossless-claw",
            memoryFlush: { model: "openai-codex/gpt-5.4-mini" },
          },
        },
      },
    });

    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4",
      provider: "lossless-claw",
      memoryFlush: { model: "openai/gpt-5.4-mini" },
    });
    expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.4"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(result.warnings).toStrictEqual([
      losslessCompactionWarning(
        "- agents.defaults.compaction.provider: lossless-claw should become plugins.slots.contextEngine: lossless-claw.",
        "- agents.defaults.compaction.model: openai/gpt-5.4 should become plugins.entries.lossless-claw.config.summaryModel.",
      ),
    ]);
  });

  it("preserves Codex runtime policy for each migrated per-agent Lossless model", () => {
    const result = maybeRepairCodexRoutes({
      models: {
        providers: {
          openai: { baseUrl: "https://proxy.example.test/v1", agentRuntime: { id: "openclaw" } },
        },
      },
      agents: {
        defaults: {
          model: "openai-codex/gpt-5.5",
          compaction: { model: "openai-codex/gpt-5.4-mini", provider: "lossless-claw" },
        },
        list: ["fast", "deep"].map((id) => ({
          id,
          model: "openai/gpt-5.5",
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
          },
          compaction: { model: "openai-codex/gpt-5.4-mini" },
        })),
      },
    });

    expect(result.cfg.plugins?.slots?.contextEngine).toBe("lossless-claw");
    expect(result.cfg.plugins?.entries?.["lossless-claw"]?.config).toEqual({
      summaryModel: "openai/gpt-5.4-mini",
    });
    expect(result.cfg.agents?.defaults?.compaction).toBeUndefined();
    expect(result.cfg.agents?.list?.[0]?.compaction).toBeUndefined();
    expect(result.cfg.agents?.list?.[1]?.compaction).toBeUndefined();
    expect(result.cfg.agents?.list?.[0]?.models?.["openai/gpt-5.4-mini"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(result.cfg.agents?.list?.[1]?.models?.["openai/gpt-5.4-mini"]?.agentRuntime).toEqual({
      id: "codex",
    });
  });

  it("canonicalizes inherited Lossless summary models when migration is blocked", () => {
    const result = maybeRepairCodexRoutes({
      models: {
        providers: { openai: { baseUrl: "https://proxy.example.test/v1" } },
      },
      plugins: { slots: { contextEngine: "custom-context" } },
      agents: {
        defaults: {
          model: "anthropic/claude-sonnet-4-6",
          compaction: { model: "openai-codex/gpt-5.4-mini" },
        },
        list: ["fast", "deep"].map((id) => ({
          id,
          model: "openai/gpt-5.5",
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
          },
          compaction: { provider: "lossless-claw" },
        })),
      },
    });

    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4-mini",
    });
    expect(result.cfg.agents?.list?.[0]?.compaction).toEqual({
      provider: "lossless-claw",
    });
    expect(result.cfg.agents?.list?.[0]?.models?.["openai/gpt-5.4-mini"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(result.cfg.agents?.list?.[1]?.compaction).toEqual({
      provider: "lossless-claw",
    });
    expect(result.cfg.agents?.list?.[1]?.models?.["openai/gpt-5.4-mini"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expect(result.warnings).toStrictEqual([
      losslessCompactionWarning(
        "- agents.list.fast.compaction.provider: lossless-claw should become plugins.slots.contextEngine: lossless-claw.",
        "- agents.defaults.compaction.model: openai/gpt-5.4-mini should become plugins.entries.lossless-claw.config.summaryModel.",
        "- agents.list.deep.compaction.provider: lossless-claw should become plugins.slots.contextEngine: lossless-claw.",
        "- agents.defaults.compaction.model: openai/gpt-5.4-mini should become plugins.entries.lossless-claw.config.summaryModel.",
      ),
    ]);
  });

  it("does not migrate Lossless compaction for agents whose Codex runtime pin is being cleared", () => {
    const result = maybeRepairCodexRoutes({
      agents: {
        list: [
          {
            id: "worker",
            model: "anthropic/claude-sonnet-4-6",
            agentRuntime: { id: "codex" },
            compaction: { model: "openai/gpt-5.4", provider: "lossless-claw" },
          },
        ],
      },
      hooks: { gmail: { model: "openai-codex/gpt-5.4" } },
    });

    expect(result.cfg.plugins).toBeUndefined();
    expect(result.cfg.agents?.list?.[0]).toEqual({
      id: "worker",
      model: "anthropic/claude-sonnet-4-6",
      compaction: { model: "openai/gpt-5.4", provider: "lossless-claw" },
    });
    expect(result.warnings).toStrictEqual([]);
  });

  it("does not discard a legacy Lossless model that conflicts with an existing summary model", () => {
    const result = maybeRepairCodexRoutes({
      plugins: {
        entries: {
          "lossless-claw": { enabled: true, config: { summaryModel: "openai/gpt-5.5" } },
        },
      },
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          compaction: { model: "openai/gpt-5.4", provider: "lossless-claw" },
        },
      },
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.["lossless-claw"]?.config).toEqual({
      summaryModel: "openai/gpt-5.5",
    });
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4",
      provider: "lossless-claw",
    });
  });

  it("preserves shared Lossless summary models inherited by non-Codex agents with local providers", () => {
    const result = maybeRepairCodexRoutes({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          compaction: { model: "openai/gpt-5.4", provider: "lossless-claw" },
        },
        list: [
          {
            id: "worker",
            model: "anthropic/claude-sonnet-4-6",
            compaction: { provider: "custom-summary" },
          },
        ],
      },
    });

    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins).toBeUndefined();
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4",
      provider: "lossless-claw",
    });
    expect(result.cfg.agents?.list?.[0]?.compaction).toEqual({
      provider: "custom-summary",
    });
  });

  it("removes shared default compaction fields that non-Codex agents override", () => {
    const result = maybeRepairCodexRoutes({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          compaction: {
            model: "openai/gpt-5.4",
            provider: "custom-summary",
            keepRecentTokens: 10_000,
          },
        },
        list: [
          {
            id: "worker",
            model: "anthropic/claude-sonnet-4-6",
            ...({
              compaction: { model: "anthropic/claude-haiku-4-6" },
            } as Record<string, unknown>),
          },
        ],
      },
    });

    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      provider: "custom-summary",
      keepRecentTokens: 10_000,
    });
    expect(result.warnings).toStrictEqual([
      codexCompactionWarning(
        "- agents.defaults.compaction.provider: custom-summary is ignored while this agent uses Codex runtime.",
        "- Move or remove shared `agents.defaults.compaction.model/provider` settings manually; doctor keeps shared defaults while non-Codex agents can inherit them.",
      ),
    ]);
  });

  it("does not ignore active runtime pins for unrepaired stale refs", () => {
    const cfg = {
      models: {
        providers: {
          openai: { baseUrl: "https://proxy.example.test/v1", models: [] },
        },
      },
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          agentRuntime: { id: "codex" },
          compaction: { model: "openai/gpt-5.4", provider: "custom-summary" },
        },
        list: [{ id: "worker", model: "anthropic/claude-sonnet-4-6" }],
      },
      hooks: { gmail: { model: "openai-codex/gpt-5.4" } },
    } as unknown as OpenClawConfig;

    expect(collectCodexRouteWarnings(cfg)).toStrictEqual([
      legacyRouteWarning("- hooks.gmail.model: openai-codex/gpt-5.4 should become openai/gpt-5.4."),
      codexCompactionWarning(
        "- agents.defaults.compaction.model: openai/gpt-5.4 is ignored while this agent uses Codex runtime.",
        "- agents.defaults.compaction.provider: custom-summary is ignored while this agent uses Codex runtime.",
        "- Run `openclaw doctor --fix`: it removes unsupported Codex compaction overrides.",
      ),
    ]);

    const result = maybeRepairCodexRoutes(cfg);

    expect(result.changes).toStrictEqual(CODEX_COMPACTION_REPAIR_CHANGES);
    expect(result.cfg.agents?.defaults?.compaction).toBeUndefined();
    expect(result.cfg.agents?.defaults?.agentRuntime).toEqual({ id: "codex" });
    expect(result.cfg.hooks?.gmail?.model).toBe("openai-codex/gpt-5.4");
  });

  it("keeps global runtime pins while a blocked namespace remains", () => {
    const result = maybeRepairCodexRoutes({
      models: {
        providers: {
          openai: {
            models: [{ id: "gpt-5.6-sol", api: "openai-responses" }],
          },
          "openai-codex": {
            models: [{ id: "gpt-5.6-sol", api: "openai-chatgpt-responses" }],
          },
        },
      },
      agents: {
        defaults: { model: "openai-codex/gpt-5.6-sol", agentRuntime: { id: "codex" } },
      },
      hooks: {
        mappings: [{ model: "codex/gpt-5.4-mini" }],
      },
    });

    expect(result.cfg.agents?.defaults?.model).toBe("openai-codex/gpt-5.6-sol");
    expect(result.cfg.agents?.defaults?.agentRuntime).toEqual({ id: "codex" });
    expect(result.cfg.hooks?.mappings?.[0]?.model).toBe("openai/gpt-5.4-mini");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(
      "Legacy Codex provider routes require manual reconciliation",
    );
  });

  it("keeps doctor fix hint for agent-specific compaction overrides", () => {
    const warnings = collectCodexRouteWarnings({
      agents: {
        defaults: {
          model: "anthropic/claude-sonnet-4-6",
          compaction: { model: "openai/gpt-5.4", provider: "custom-summary" },
        },
        list: [
          { id: "codex", model: "openai/gpt-5.5", compaction: { model: "openai/gpt-5.4" } },
          { id: "worker", model: "anthropic/claude-sonnet-4-6" },
        ],
      },
    });

    expect(warnings).toStrictEqual([
      codexCompactionWarning(
        "- agents.defaults.compaction.provider: custom-summary is ignored while this agent uses Codex runtime.",
        "- Move or remove shared `agents.defaults.compaction.model/provider` settings manually; doctor keeps shared defaults while non-Codex agents can inherit them.",
      ),
      codexCompactionWarning(
        "- agents.list.codex.compaction.model: openai/gpt-5.4 is ignored while this agent uses Codex runtime.",
        "- Run `openclaw doctor --fix`: it removes unsupported Codex compaction overrides.",
      ),
    ]);
  });

  it("does not broaden runtime policy from kept compaction-only refs", () => {
    const result = maybeRepairCodexRoutes({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            agentRuntime: { id: "openclaw" },
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          agentRuntime: { id: "codex" },
          model: "openai-codex/gpt-5.5",
          heartbeat: { model: "openai/gpt-5.4" },
          compaction: { model: "openai-codex/gpt-5.4", provider: "custom-summary" },
        },
        list: [{ id: "worker", model: "anthropic/claude-sonnet-4-6" }],
      },
    });

    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(result.cfg.agents?.defaults?.heartbeat?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4",
      provider: "custom-summary",
    });
    expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.4"]).toBeUndefined();
    expectAgentRuntime(result.cfg, "openclaw");
  });

  it("repairs configured Codex model refs to canonical OpenAI refs with model-scoped Codex runtime", () => {
    const result = maybeRepairCodexRoutes(
      {
        agents: {
          defaults: {
            agentRuntime: { id: "codex" },
            model: {
              primary: "openai-codex/gpt-5.5",
              fallbacks: ["openai-codex/gpt-5.4", "anthropic/claude-sonnet-4-6"],
            },
            heartbeat: { model: "openai-codex/gpt-5.4-mini" },
            subagents: {
              model: {
                primary: "openai-codex/gpt-5.5",
                fallbacks: ["openai-codex/gpt-5.4"],
              },
            },
            compaction: {
              model: "openai-codex/gpt-5.4",
              memoryFlush: { model: "openai-codex/gpt-5.4-mini" },
            },
            mediaModels: {
              image: {
                primary: "openai-codex/gpt-image-2",
                fallbacks: ["openai-codex/gpt-image-1"],
              },
              video: { primary: "openai-codex/sora-2" },
            },
            models: { "openai-codex/gpt-5.5": { alias: "codex" } },
          },
          entries: {
            worker: { model: "openai-codex/gpt-5.4", agentRuntime: { id: "codex" } },
          },
        },
        channels: {
          modelByChannel: { telegram: { default: "openai-codex/gpt-5.4" } },
        },
        hooks: {
          mappings: [
            {
              model: "openai-codex/gpt-5.4-mini",
            },
          ],
          gmail: { model: "openai-codex/gpt-5.4" },
        },
        tts: { summaryModel: "openai-codex/gpt-5.4-mini" },
      },
      { codexRuntimeReady: true },
    );

    expect(result.warnings).toStrictEqual([]);
    expect(result.cfg.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["openai/gpt-5.4", "anthropic/claude-sonnet-4-6"],
    });
    expect(result.cfg.agents?.defaults?.heartbeat?.model).toBe("openai/gpt-5.4-mini");
    expect(result.cfg.agents?.defaults?.subagents?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["openai/gpt-5.4"],
    });
    expect(result.cfg.agents?.defaults?.compaction?.model).toBeUndefined();
    expect(result.cfg.agents?.defaults?.compaction?.memoryFlush?.model).toBe("openai/gpt-5.4-mini");
    expect(result.cfg.agents?.defaults?.mediaModels?.image).toEqual({
      primary: "openai/gpt-image-2",
      fallbacks: ["openai/gpt-image-1"],
    });
    expect(result.cfg.agents?.defaults?.mediaModels?.video).toEqual({
      primary: "openai/sora-2",
    });
    expect(result.cfg.agents?.defaults?.agentRuntime).toBeUndefined();
    expect(result.cfg.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": { alias: "codex", agentRuntime: { id: "codex" } },
      "openai/gpt-5.4": { agentRuntime: { id: "codex" } },
    });
    expect(result.cfg.agents?.entries?.worker?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.entries?.worker?.agentRuntime).toBeUndefined();
    expect(result.cfg.agents?.entries?.worker?.models).toEqual({
      "openai/gpt-5.4": { agentRuntime: { id: "codex" } },
    });
    expect(result.cfg.channels?.modelByChannel?.telegram?.default).toBe("openai/gpt-5.4");
    expect(result.cfg.hooks?.mappings?.[0]?.model).toBe("openai/gpt-5.4-mini");
    expect(result.cfg.hooks?.gmail?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.tts?.summaryModel).toBe("openai/gpt-5.4-mini");
  });

  it("keeps whole-agent runtime pins while repairing compaction-only model refs and overrides", () => {
    const result = maybeRepairCodexRoutes(
      {
        agents: {
          defaults: {
            agentRuntime: { id: "codex" },
            model: "anthropic/claude-sonnet-4.6",
            compaction: {
              model: "openai/gpt-5.4",
              provider: "custom-summary",
              memoryFlush: { model: "openai-codex/gpt-5.4-mini" },
            },
          },
        },
      },
      { codexRuntimeReady: true },
    );

    expect(result.warnings).toStrictEqual([]);
    expect(result.cfg.agents?.defaults?.agentRuntime).toEqual({ id: "codex" });
    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      memoryFlush: { model: "openai/gpt-5.4-mini" },
    });
  });

  it("warns without overriding an explicit Codex plugin opt-out", () => {
    const result = maybeRepairCodexRoutes({
      plugins: {
        allow: ["openai"],
        entries: { openai: { enabled: true }, codex: { enabled: false } },
      },
      agents: {
        defaults: { model: { primary: "gpt-5.5" } },
      },
    });

    expect(result.warnings).toStrictEqual([
      disabledCodexPluginWarning(
        "- agents.defaults.model.primary: gpt-5.5 resolves to openai/gpt-5.5 with Codex runtime while the Codex plugin is disabled by config.",
      ),
    ]);
    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
    expect(result.cfg.plugins?.allow).toEqual(["openai"]);
    expectAgentRuntime(result.cfg, "codex", { modelId: "gpt-5.5" });
  });

  itReenablesCodexPlugin(
    "re-enables the Codex plugin when an agent model alias resolves to OpenAI",
    {
      agents: {
        defaults: {
          model: "xiaomi/mimo-v2-pro-mit",
          models: { "openai/xiaomi/mimo-v2-pro-mit": { alias: "xiaomi/mimo-v2-pro-mit" } },
        },
      },
    },
  );

  itKeepsCodexPluginDisabled(
    "keeps the Codex plugin disabled when a bare alias inherits a default provider from the primary alias",
    {
      agents: {
        defaults: {
          model: "sonnet",
          models: {
            "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
            "claude-opus-4-6": { alias: "opus" },
          },
          subagents: { model: "opus" },
        },
      },
    },
  );

  itKeepsCodexPluginDisabled(
    "keeps Codex disabled when implicit defaults resolve to a configured provider",
    {
      models: {
        providers: {
          anthropic: {
            models: [{ id: "claude-sonnet-4-6" }],
          },
        },
      },
      agents: {
        defaults: {},
      },
    },
  );

  itReenablesCodexPlugin(
    "re-enables Codex for default model-map runtime policies inherited by listed agents",
    {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
          },
        },
        list: [{ id: "worker", model: "anthropic/claude-sonnet-4-6" }],
      },
    },
  );

  itKeepsCodexPluginDisabled(
    "keeps Codex disabled when a bare alias inherits an OpenRouter compat primary provider",
    {
      agents: {
        defaults: {
          model: "openrouter:auto",
          models: { "claude-sonnet-4-6": { alias: "sonnet" } },
          subagents: { model: "sonnet" },
        },
      },
    },
  );

  itKeepsCodexPluginDisabled(
    "keeps Codex disabled when an alias resolves to an OpenRouter compat model",
    {
      agents: {
        defaults: {
          model: "router-auto",
          models: { "openrouter:auto": { alias: "router-auto" } },
        },
      },
    },
  );

  itReenablesCodexPlugin("checks channel model runtime policy for every configured agent", {
    agents: {
      defaults: {
        model: "anthropic/claude-sonnet-4-6",
        models: {
          "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
        },
      },
      list: [
        { id: "main" },
        {
          id: "worker",
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
          },
        },
      ],
    },
    channels: {
      modelByChannel: { telegram: { default: "openai/gpt-5.5" } },
    },
  });

  itKeepsCodexPluginDisabled(
    "uses normalized runtime agent ids when checking model runtime policy",
    {
      agents: {
        list: [
          {
            id: "",
            model: "gpt-5.5",
            models: {
              "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
            },
          },
        ],
      },
    },
  );

  itKeepsCodexPluginDisabled(
    "keeps the Codex plugin disabled when a bare model case-insensitively resolves to a configured provider",
    {
      models: {
        providers: {
          "qwen-dashscope": {
            models: [{ id: "Qwen-Max" }],
          },
        },
      },
      agents: { defaults: { model: "qwen-max" } },
    },
  );

  it("repairs live multi-agent Codex upgrade configs and enables Codex through allowlists", () => {
    const result = maybeRepairCodexRoutes({
      plugins: {
        allow: ["brave", "discord", "whatsapp"],
        entries: {
          brave: { enabled: true },
          discord: { enabled: true },
          whatsapp: { enabled: true },
        },
      },
      agents: {
        defaults: { model: "openai-codex/gpt-5.5" },
        list: [
          { id: "main", model: "openai-codex/gpt-5.5" },
          { id: "meimei", model: "openai-codex/gpt-5.5" },
          { id: "youyou-cli", model: "openai-codex/gpt-5.5" },
        ],
      },
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(result.cfg.agents?.list?.map((agent) => agent.model)).toEqual([
      "openai/gpt-5.5",
      "openai/gpt-5.5",
      "openai/gpt-5.5",
    ]);
    expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.5"]?.agentRuntime).toEqual({
      id: "codex",
    });
    for (const agent of result.cfg.agents?.list ?? []) {
      expect(agent.models?.["openai/gpt-5.5"]?.agentRuntime).toEqual({ id: "codex" });
    }
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.cfg.plugins?.allow).toEqual(["brave", "discord", "whatsapp", "codex"]);
  });

  it("preserves listed-agent legacy model-map runtime pins while repairing listed-agent refs", () => {
    const cfg = {
      agents: {
        list: [
          {
            id: "worker",
            model: "openai-codex/gpt-5.4",
            models: {
              "openai-codex/gpt-5.4": { agentRuntime: { id: "openclaw" } },
            },
          },
        ],
      },
    } as unknown as OpenClawConfig;

    expectAgentRuntime(cfg, "openclaw", { provider: "openai-codex", agentId: "worker" });

    const result = maybeRepairCodexRoutes(cfg);

    expect(result.cfg.agents?.list?.[0]?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.list?.[0]?.models?.["openai/gpt-5.4"]?.agentRuntime).toEqual({
      id: "openclaw",
    });
    expect(result.cfg.agents?.list?.[0]?.models?.["openai-codex/gpt-5.4"]).toBeUndefined();
    expectAgentRuntime(result.cfg, "openclaw", { agentId: "worker" });
  });

  it("preserves inherited default wildcard runtime pins for listed-agent legacy refs", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai-codex/*": { agentRuntime: { id: "openclaw" } },
          },
        },
        list: [{ id: "worker", model: "openai-codex/gpt-5.4" }],
      },
    } as unknown as OpenClawConfig;

    expectAgentRuntime(cfg, "openclaw", { provider: "openai-codex", agentId: "worker" });

    const result = maybeRepairCodexRoutes(cfg);

    expect(result.cfg.agents?.defaults?.models?.["openai/*"]?.agentRuntime).toEqual({
      id: "openclaw",
    });
    expect(result.cfg.agents?.defaults?.models?.["openai-codex/*"]).toBeUndefined();
    expect(result.cfg.agents?.list?.[0]?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.list?.[0]?.models?.["openai/gpt-5.4"]).toBeUndefined();
    expectAgentRuntime(result.cfg, "openclaw", { agentId: "worker" });
  });

  it("preserves legacy provider catalog runtime pins while repairing default legacy refs", () => {
    const cfg = {
      models: {
        providers: {
          "openai-codex": {
            models: [{ id: "gpt-5.4", agentRuntime: { id: "openclaw" } }],
          },
        },
      },
      agents: { defaults: { model: "openai-codex/gpt-5.4" } },
    } as unknown as OpenClawConfig;

    expectAgentRuntime(cfg, "openclaw", { provider: "openai-codex" });

    const result = maybeRepairCodexRoutes(cfg);

    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.4"]?.agentRuntime).toEqual({
      id: "openclaw",
    });
    expectAgentRuntime(result.cfg, "openclaw");
  });

  it("shields listed canonical refs when provider-level legacy default pins migrate", () => {
    const cfg = {
      models: {
        providers: {
          "openai-codex": { agentRuntime: { id: "openclaw" } },
        },
      },
      agents: {
        defaults: { model: "openai-codex/gpt-5.4" },
        list: [
          { id: "main", default: true },
          { id: "regular", model: "openai/gpt-5.4" },
        ],
      },
    } as unknown as OpenClawConfig;

    expectAgentRuntime(cfg, "openclaw", { provider: "openai-codex", agentId: "main" });
    expectAgentRuntime(cfg, "codex", { agentId: "regular" });

    const result = maybeRepairCodexRoutes(cfg);

    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.4"]?.agentRuntime).toEqual({
      id: "openclaw",
    });
    expect(result.cfg.agents?.list?.[0]?.model).toBeUndefined();
    expect(result.cfg.agents?.list?.[1]?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.list?.[1]?.models?.["openai/gpt-5.4"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expectAgentRuntime(result.cfg, "openclaw", { agentId: "main" });
    expectAgentRuntime(result.cfg, "codex", { agentId: "regular" });
  });

  it("does not apply pre-existing canonical default runtime pins to listed-agent legacy refs", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "openai/*": { agentRuntime: { id: "openclaw" } },
          },
        },
        list: [{ id: "worker", model: "openai-codex/gpt-5.4" }],
      },
    } as unknown as OpenClawConfig;

    expectAgentRuntime(cfg, "auto", { provider: "openai-codex", agentId: "worker" });

    const result = maybeRepairCodexRoutes(cfg);

    expect(result.cfg.agents?.defaults?.models?.["openai/*"]?.agentRuntime).toEqual({
      id: "openclaw",
    });
    expect(result.cfg.agents?.list?.[0]?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.list?.[0]?.models?.["openai/gpt-5.4"]?.agentRuntime).toEqual({
      id: "codex",
    });
    expectAgentRuntime(result.cfg, "codex", { agentId: "worker" });
  });

  it("leaves path-scoped agent refs unchanged when repair would broaden another canonical agent slot", () => {
    const result = maybeRepairCodexRoutes({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            agentRuntime: { id: "openclaw" },
            models: [],
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          heartbeat: { model: "openai-codex/gpt-5.4" },
        },
      },
    });

    expect(result.cfg.agents?.defaults?.model).toEqual({ primary: "openai/gpt-5.4" });
    expect(result.cfg.agents?.defaults?.heartbeat?.model).toBe("openai-codex/gpt-5.4");
    expect(result.cfg.agents?.defaults?.models).toBeUndefined();
    expectAgentRuntime(result.cfg, "openclaw");
    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([
      legacyRouteWarning(
        "- agents.defaults.heartbeat.model: openai-codex/gpt-5.4 should become openai/gpt-5.4.",
      ),
    ]);
  });

  it("repairs persisted session routes while preserving selected auth accounts", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "openai-codex",
        model: "gpt-5.5",
        providerOverride: "openai-codex",
        modelOverride: "openai-codex/gpt-5.4",
        modelOverrideSource: "auto",
        agentHarnessId: "codex",
        agentRuntimeOverride: "codex",
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 2,
        fallbackNotice: {
          kind: "active",
          selectedModel: "openai-codex/gpt-5.5",
          activeModel: "openai-codex/gpt-5.4",
          reason: "rate-limit",
        },
      },
      other: { sessionId: "s2", updatedAt: 2, agentHarnessId: "codex" },
    };

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
      authProfileIdMap: new Map([["openai-codex:default", "openai:chatgpt-default"]]),
    });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(getSession(store, "main").updatedAt).toBe(123);
    expect(getSession(store, "main").modelProvider).toBe("openai");
    expect(getSession(store, "main").model).toBe("gpt-5.5");
    expect(getSession(store, "main").providerOverride).toBe("openai");
    expect(getSession(store, "main").modelOverride).toBe("gpt-5.4");
    expect(getSession(store, "main").modelOverrideSource).toBe("auto");
    expect(getSession(store, "main").modelOverrideRouteResolution).toBe("resolved");
    expect(getSession(store, "main").authProfileOverride).toBe("openai:chatgpt-default");
    expect(getSession(store, "main").authProfileOverrideSource).toBe("auto");
    expect(getSession(store, "main").authProfileOverrideCompactionCount).toBe(2);
    expect(getSession(store, "main").agentHarnessId).toBeUndefined();
    expect(getSession(store, "main").agentRuntimeOverride).toBe("codex");
    expect(getSession(store, "main").fallbackNotice).toBeUndefined();
    expect(getSession(store, "other").updatedAt).toBe(2);
    expect(getSession(store, "other").agentHarnessId).toBe("codex");
  });

  it("rewrites only exactly mapped auth pins on otherwise canonical sessions", () => {
    const store: Record<string, SessionEntry> = {
      selected: {
        sessionId: "selected",
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-5.5",
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 3,
      },
      unknown: {
        sessionId: "unknown",
        updatedAt: 2,
        authProfileOverride: "openai-codex:missing",
        authProfileOverrideSource: "user",
      },
      canonical: {
        sessionId: "canonical",
        updatedAt: 3,
        authProfileOverride: "openai:default",
        authProfileOverrideSource: "auto",
      },
    };
    const authProfileIdMap = new Map([["openai-codex:default", "openai:chatgpt-default"]]);

    expect(repairCodexSessionStoreRoutes({ store, now: 123, authProfileIdMap })).toEqual({
      changed: true,
      sessionKeys: ["selected"],
    });
    expect(store.selected).toMatchObject({
      updatedAt: 123,
      authProfileOverride: "openai:chatgpt-default",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 3,
    });
    expect(store.unknown).toMatchObject({
      updatedAt: 2,
      authProfileOverride: "openai-codex:missing",
    });
    expect(store.canonical).toMatchObject({
      updatedAt: 3,
      authProfileOverride: "openai:default",
    });
    expect(repairCodexSessionStoreRoutes({ store, now: 456, authProfileIdMap })).toEqual({
      changed: false,
      sessionKeys: [],
    });
    expect(store.selected?.updatedAt).toBe(123);
  });

  it("repairs shipped codex namespace session route refs", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "codex",
        model: "codex/gpt-5.6-sol",
        providerOverride: "codex",
        modelOverride: "codex/gpt-5.6-sol",
        authProfileOverride: "codex:default",
        authProfileOverrideSource: "auto",
        fallbackNotice: {
          kind: "active",
          selectedModel: "codex/gpt-5.6-sol",
          activeModel: "openai/gpt-5.6-sol",
        },
        agentRuntimeOverride: "codex",
      },
    };

    const result = repairCodexSessionStoreRoutes({ store, now: 123 });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(store.main).toMatchObject({
      modelProvider: "openai",
      model: "gpt-5.6-sol",
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
      authProfileOverride: "codex:default",
      updatedAt: 123,
    });
    expect(store.main?.fallbackNotice).toBeUndefined();
    expect(store.main?.agentRuntimeOverride).toBe("codex");
  });

  it("treats slash model ids as raw for custom providers while migrating legacy pairs", () => {
    const store: Record<string, SessionEntry> = {
      custom: {
        sessionId: "s-custom",
        updatedAt: 1,
        modelProvider: "custom",
        model: "codex/foo",
        providerOverride: "custom",
        modelOverride: "openai-codex/bar",
        agentRuntimeOverride: "openclaw",
      },
      legacy: {
        sessionId: "s-legacy",
        updatedAt: 2,
        modelProvider: "codex",
        model: "codex/foo",
      },
    };

    const result = repairCodexSessionStoreRoutes({ store, now: 123 });

    expect(result).toEqual({ changed: true, sessionKeys: ["legacy"] });
    expect(store.custom).toMatchObject({
      modelProvider: "custom",
      model: "codex/foo",
      providerOverride: "custom",
      modelOverride: "openai-codex/bar",
      agentRuntimeOverride: "openclaw",
      updatedAt: 1,
    });
    expect(store.legacy).toMatchObject({
      modelProvider: "openai",
      model: "foo",
      agentRuntimeOverride: "codex",
      updatedAt: 123,
    });
  });

  it("keeps the whole provider-conflicted session namespace legacy", () => {
    const store: Record<string, SessionEntry> = {
      blocked: {
        sessionId: "s-blocked",
        updatedAt: 1,
        modelProvider: "codex",
        model: "gpt-5.6-sol",
        providerOverride: "codex",
        modelOverride: "codex/gpt-5.6-sol",
      },
      migrate: {
        sessionId: "s-migrate",
        updatedAt: 2,
        modelProvider: "codex",
        model: "gpt-5.3-mini",
      },
      providerOnly: { sessionId: "s-provider-only", updatedAt: 3, modelProvider: "codex" },
    };
    const blockedNamespace = expectDefined(
      legacyCodexProviderIdentityKey("codex"),
      "blocked session namespace test invariant",
    );

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
      blockedModelIdentities: new Set([blockedNamespace]),
    });

    expect(result).toEqual({ changed: false, sessionKeys: [] });
    expect(store.blocked).toMatchObject({
      modelProvider: "codex",
      model: "gpt-5.6-sol",
      providerOverride: "codex",
      modelOverride: "codex/gpt-5.6-sol",
      updatedAt: 1,
    });
    expect(store.migrate).toMatchObject({
      modelProvider: "codex",
      model: "gpt-5.3-mini",
      updatedAt: 2,
    });
    expect(store.providerOnly).toMatchObject({
      modelProvider: "codex",
      updatedAt: 3,
    });
  });

  it("retains a fallback notice atomically when one legacy endpoint is blocked", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-5.6-sol",
        fallbackNotice: {
          kind: "active",
          selectedModel: "codex/gpt-5.6-sol",
          activeModel: "openai/gpt-5.6-sol",
          reason: "rate-limit",
        },
      },
    };
    // Build the blocked identity through the production plan so the test
    // exercises the same composition doctor uses.
    const blockedIdentity = expectDefined(
      collectBlockedLegacyOpenAICodexProviderPlan({
        models: {
          providers: {
            codex: { models: [{ id: "gpt-5.6-sol", api: "openai-responses" }] },
            openai: { models: [{ id: "gpt-5.6-sol", api: "openai-chatgpt-responses" }] },
          },
        },
      }).blockedModelIdentities[0],
      "blocked fallback notice model identity test invariant",
    );

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
      blockedModelIdentities: new Set([blockedIdentity]),
    });

    expect(result).toEqual({ changed: false, sessionKeys: [] });
    expect(store.main).toMatchObject({
      updatedAt: 1,
      fallbackNotice: {
        kind: "active",
        selectedModel: "codex/gpt-5.6-sol",
        activeModel: "openai/gpt-5.6-sol",
        reason: "rate-limit",
      },
    });
  });

  it("leaves session runtime intent untouched for fallback-notice-only cleanup", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-5.6-sol",
        fallbackNotice: {
          kind: "active",
          selectedModel: "codex/gpt-5.6-sol",
          activeModel: "openai/gpt-5.6-sol",
          reason: "rate-limit",
        },
      },
    };

    const result = repairCodexSessionStoreRoutes({ store, now: 123 });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(store.main?.fallbackNotice).toBeUndefined();
    expect(store.main?.agentRuntimeOverride).toBeUndefined();
    expect(store.main?.agentHarnessId).toBeUndefined();
  });

  it("skips valid locked agent-harness rows while repairing ordinary legacy routes", () => {
    const supervisedKey = "agent:main:harness:codex:supervision:abc123";
    const ordinaryLockedKey = "agent:main:ordinary-locked";
    const lockedEntry: SessionEntry = {
      sessionId: "s-supervised",
      updatedAt: 1,
      modelSelectionLocked: true,
      agentHarnessId: "codex",
      agentRuntimeOverride: "codex",
      modelProvider: "openai-codex",
      model: "gpt-5.5",
      providerOverride: "openai-codex",
      modelOverride: "openai-codex/gpt-5.4",
      fallbackNotice: {
        kind: "active",
        selectedModel: "openai-codex/gpt-5.5",
        activeModel: "openai-codex/gpt-5.4",
      },
    };
    const store: Record<string, SessionEntry> = {
      [supervisedKey]: lockedEntry,
      [ordinaryLockedKey]: { ...lockedEntry, sessionId: "s-ordinary-locked" },
      ordinary: {
        sessionId: "s-ordinary",
        updatedAt: 2,
        modelProvider: "openai-codex",
        model: "gpt-5.5",
        agentHarnessId: "codex",
      },
    };
    const supervised = structuredClone(store[supervisedKey]);
    const ordinaryLocked = structuredClone(store[ordinaryLockedKey]);

    const result = repairCodexSessionStoreRoutes({ store, now: 123 });

    expect(result).toEqual({ changed: true, sessionKeys: ["ordinary"] });
    expect(store[supervisedKey]).toEqual(supervised);
    expect(store[ordinaryLockedKey]).toEqual(ordinaryLocked);
    expect(store.ordinary).toMatchObject({
      updatedAt: 123,
      modelProvider: "openai",
      model: "gpt-5.5",
    });
    expect(getSession(store, "ordinary").agentHarnessId).toBeUndefined();
  });

  it("preserves explicit OpenClaw runtime pins while repairing legacy session routes", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "openai-codex",
        model: "gpt-5.5",
        providerOverride: "openai-codex",
        modelOverride: "openai-codex/gpt-5.4",
        agentHarnessId: "pi",
        agentRuntimeOverride: "pi",
        authProfileOverride: "openai-codex:default",
      },
    };

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
    });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(getSession(store, "main").modelProvider).toBe("openai");
    expect(getSession(store, "main").model).toBe("gpt-5.5");
    expect(getSession(store, "main").providerOverride).toBe("openai");
    expect(getSession(store, "main").modelOverride).toBe("gpt-5.4");
    expect(getSession(store, "main").agentHarnessId).toBe("pi");
    expect(getSession(store, "main").agentRuntimeOverride).toBe("pi");
    expect(getSession(store, "main").authProfileOverride).toBe("openai-codex:default");
  });

  it("repairs providerless auto Codex session overrides", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelProvider: "ollama",
        model: "gpt-5.5",
        modelOverride: "gpt-5.5",
        modelOverrideSource: "auto",
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "auto",
        contextTokens: 64_000,
        contextTokensSource: "runtime",
        contextBudgetStatus: {
          schemaVersion: 1,
          source: "pre-prompt-estimate",
          updatedAt: 1,
          provider: "ollama",
          model: "gpt-5.5",
          route: "fits",
          shouldCompact: false,
          estimatedPromptTokens: 1_000,
          contextTokenBudget: 64_000,
          promptBudgetBeforeReserve: 62_000,
          reserveTokens: 2_000,
          effectiveReserveTokens: 2_000,
          remainingPromptBudgetTokens: 61_000,
          overflowTokens: 0,
          toolResultReducibleChars: 0,
          messageCount: 1,
          unwindowedMessageCount: 1,
        },
      },
    };

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
      authProfileIdMap: new Map([["openai-codex:default", "openai:chatgpt-default"]]),
    });

    expect(result).toEqual({ changed: true, sessionKeys: ["main"] });
    expect(getSession(store, "main").updatedAt).toBe(123);
    expect(getSession(store, "main").providerOverride).toBe("openai");
    expect(getSession(store, "main").modelOverride).toBe("gpt-5.5");
    expect(getSession(store, "main").modelOverrideSource).toBe("auto");
    expect(getSession(store, "main").modelOverrideRouteResolution).toBe("resolved");
    expect(getSession(store, "main").authProfileOverride).toBe("openai:chatgpt-default");
    expect(getSession(store, "main").authProfileOverrideSource).toBe("auto");
    expect(getSession(store, "main").modelProvider).toBeUndefined();
    expect(getSession(store, "main").model).toBeUndefined();
    expect(getSession(store, "main").contextTokens).toBeUndefined();
    expect(getSession(store, "main").contextTokensSource).toBeUndefined();
    expect(getSession(store, "main").contextBudgetStatus).toBeUndefined();
  });

  it("preserves legacy providerless overrides with Codex auth pins", () => {
    const store: Record<string, SessionEntry> = {
      main: {
        sessionId: "s1",
        updatedAt: 1,
        modelOverride: "gpt-5.5",
        authProfileOverride: "openai-codex:default",
        authProfileOverrideSource: "auto",
      },
    };

    const result = repairCodexSessionStoreRoutes({
      store,
      now: 123,
    });

    expect(result).toEqual({ changed: false, sessionKeys: [] });
    expect(getSession(store, "main").updatedAt).toBe(1);
    expect(getSession(store, "main").providerOverride).toBeUndefined();
    expect(getSession(store, "main").modelOverride).toBe("gpt-5.5");
  });

  for (const canonicalRuntimeId of ["auto", "default"] as const) {
    it(`preserves an explicit legacy runtime pin over canonical ${canonicalRuntimeId} during model-map migration`, () => {
      const result = maybeRepairCodexRoutes({
        agents: {
          defaults: {
            model: { primary: "openai-codex/gpt-5.4" },
            models: {
              "openai-codex/gpt-5.4": { agentRuntime: { id: "openclaw" } },
              "openai/gpt-5.4": {
                alias: "canonical-codex",
                agentRuntime: { id: canonicalRuntimeId },
              },
            },
          },
        },
        plugins: DISABLED_CODEX_PLUGIN_CONFIG,
      });

      expect(result.cfg.agents?.defaults?.model).toEqual({ primary: "openai/gpt-5.4" });
      expect(result.cfg.agents?.defaults?.models?.["openai/gpt-5.4"]).toEqual({
        alias: "canonical-codex",
        agentRuntime: { id: "openclaw" },
      });
      expect(result.cfg.agents?.defaults?.models?.["openai-codex/gpt-5.4"]).toBeUndefined();
      expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
      expectAgentRuntime(result.cfg, "openclaw");
    });
  }
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
