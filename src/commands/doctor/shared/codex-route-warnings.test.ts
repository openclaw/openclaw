import { describe, expect, it, vi } from "vitest";
import { resolveAgentHarnessPolicy } from "../../../agents/harness/policy.js";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import type { ModelDefinitionConfig } from "../../../config/types.models.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

// mock-isolation: Route warnings use synthetic profiles, never the operator's credential store.
vi.mock("../../../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: vi.fn().mockReturnValue({ profiles: {}, usageStats: {} }),
  resolveAuthProfileOrder: vi.fn().mockReturnValue([]),
  resolveProfileUnusableUntilForDisplay: vi.fn().mockReturnValue(null),
}));

// mock-isolation: Eligibility is fixed for route-policy proof without probing real credentials.
vi.mock("../../../agents/auth-profiles/credential-state.js", () => ({
  evaluateStoredCredentialEligibility: vi
    .fn()
    .mockReturnValue({ eligible: true, reasonCode: "ok" }),
}));

vi.mock("../../../plugins/installed-plugin-index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../plugins/installed-plugin-index.js")>()),
  isInstalledPluginEnabled: vi.fn().mockReturnValue(false),
  loadInstalledPluginIndex: vi.fn().mockReturnValue({ plugins: [] }),
}));

import {
  collectCodexRouteWarnings as collectCodexRouteWarningsUnderTest,
  maybeRepairCodexRoutes as maybeRepairCodexRoutesUnderTest,
} from "./codex-route-warnings.js";

function expectWarnings(actual: string[], expected: string[][]) {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((fragments, index) => {
    for (const fragment of fragments) {
      expect(actual[index]).toContain(fragment);
    }
  });
}

function expectLosslessWarning(warnings: string[], ...paths: string[]) {
  expectWarnings(warnings, [
    [
      "Legacy Lossless compaction",
      ...paths,
      "plugins.slots.contextEngine",
      "plugins.entries.lossless-claw.config.summaryModel",
      "Move the Lossless config manually",
    ],
  ]);
}

const DISABLED_CODEX_PLUGIN_CONFIG = { entries: { codex: { enabled: false } } };
const MODEL_CATALOG_METADATA = {
  name: "Test model",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  maxTokens: 4096,
} satisfies Omit<ModelDefinitionConfig, "id">;

function collectCodexRouteWarnings(cfg: OpenClawConfigWithLegacyRoster): string[] {
  return collectCodexRouteWarningsUnderTest({ cfg });
}

function maybeRepairCodexRoutes(cfg: OpenClawConfigWithLegacyRoster) {
  return maybeRepairCodexRoutesUnderTest({ cfg });
}

type Agents = NonNullable<OpenClawConfigWithLegacyRoster["agents"]>;
type RouteFixture = Omit<OpenClawConfigWithLegacyRoster, "agents" | "models"> & {
  defaults?: Agents["defaults"];
  list?: Agents["list"];
  entries?: Agents["entries"];
  providers?: NonNullable<OpenClawConfig["models"]>["providers"];
};
function fixture({
  defaults,
  list,
  entries,
  providers,
  ...rest
}: RouteFixture): OpenClawConfigWithLegacyRoster {
  const agents = {
    ...(defaults !== undefined ? { defaults } : {}),
    ...(list ? { list } : {}),
    ...(entries ? { entries } : {}),
  };
  return {
    ...rest,
    ...(Object.keys(agents).length ? { agents } : {}),
    ...(providers ? { models: { providers } } : {}),
  };
}
function repairFixture(config: RouteFixture) {
  return maybeRepairCodexRoutes(fixture(config));
}

function computerUseConfig(computerUse: Record<string, unknown>): OpenClawConfig {
  return { plugins: { entries: { codex: { enabled: true, config: { computerUse } } } } };
}

function openaiProvider(
  overrides: Partial<NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]> = {},
) {
  return { baseUrl: "https://proxy.example.test/v1", models: [], ...overrides };
}

function catalogProvider(id: string, overrides: Partial<ModelDefinitionConfig> = {}) {
  return { baseUrl: "", models: [{ ...MODEL_CATALOG_METADATA, id, ...overrides }] };
}

function expectModelRuntime(model: { agentRuntime?: { id?: string } } | undefined, id = "codex") {
  expect(model?.agentRuntime).toEqual({ id });
}

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

describe("collectCodexRouteWarnings", () => {
  it.each<RouteFixture & { name: string; warning?: string[] }>([
    {
      name: "mixed provider-only and summary-model consumers",
      defaults: { model: "openai/gpt-5.5", compaction: { provider: "lossless-claw" } },
      list: [{ id: "fast", model: "openai/gpt-5.5", compaction: { model: "openai/gpt-5.4-mini" } }],
      warning: [
        "agents.defaults.compaction.provider: lossless-claw",
        "agents.list.fast.compaction.model: openai/gpt-5.4-mini",
      ],
    },
    {
      name: "conflicting existing summary model",
      defaults: {
        model: "openai/gpt-5.5",
        compaction: { model: "openai/gpt-5.4", provider: "lossless-claw" },
      },
      plugins: {
        entries: { "lossless-claw": { enabled: true, config: { summaryModel: "openai/gpt-5.5" } } },
      },
    },
    {
      name: "shared summary inherited by a non-Codex agent with a local provider",
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
  ])("preserves blocked Lossless configuration: $name", ({ name: _name, warning, ...input }) => {
    const cfg = fixture(input);
    const original = structuredClone(cfg);
    const result = maybeRepairCodexRoutes(cfg);
    expect(result.changes).toEqual([]);
    expect(result.cfg).toEqual(original);
    if (warning) {
      expectLosslessWarning(result.warnings, ...warning);
    }
  });

  it.each([false, true])("surfaces Computer Use defaults and opt-ins (opted in=%s)", (optedIn) => {
    const warnings = collectCodexRouteWarnings(
      computerUseConfig({
        enabled: true,
        ...(optedIn
          ? { healthCheckEnabled: true, healthCheckIntervalMinutes: 120, autoRepair: true }
          : {}),
      }),
    );
    expectWarnings(warnings, [
      [
        "Codex Computer Use is enabled",
        "/codex computer-use status",
        optedIn ? "120-minute cadence" : "health checks are disabled by default",
        optedIn
          ? "repair is enabled and limited to SkyComputerUseClient children"
          : "repair is disabled by default",
      ],
    ]);
  });

  it("repairs only redundant native Codex service tiers and is idempotent", () => {
    const command = "node -e process.exit(99)";
    const original = fixture({
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
      plugins: { entries: { codex: { enabled: true, config: { appServer: { command } } } } },
    });

    const repaired = maybeRepairCodexRoutes(original);

    expect(repaired.cfg.agents?.defaults?.models).toEqual({
      "openai/gpt-5.6-sol": {
        params: { fastMode: true, temperature: 0.2 },
        agentRuntime: { id: "codex" },
      },
      "openai/gpt-5.6-terra": { params: { fast_mode: "on" }, agentRuntime: { id: "codex" } },
    });
    expect(repaired.cfg.plugins?.entries?.codex?.config).toEqual({ appServer: { command } });
    expect(repaired.warnings.join("\n")).toContain(
      "Custom Codex app-server command bypasses OpenClaw's managed exact-version binary.",
    );
    expect(repaired.warnings.join("\n")).toContain("agents.defaults.params.temperature");
    expect(repaired.warnings.join("\n")).toContain(
      "agents.defaults.models.openai/gpt-5.6-sol.params.temperature",
    );
    expect(original.agents?.defaults?.models?.["openai/gpt-5.6-sol"]?.params).toHaveProperty(
      "serviceTier",
    );

    const second = maybeRepairCodexRoutes(repaired.cfg);
    expect(second.cfg).toBe(repaired.cfg);
    expect(second.changes).toStrictEqual([]);
    expect(second.warnings).toStrictEqual(repaired.warnings);
  });

  it("does not grant Lossless model override policy without a migrated summary model", () => {
    const result = repairFixture({
      defaults: {
        model: "openai/gpt-5.5",
        compaction: { provider: "lossless-claw", keepRecentTokens: 10_000 },
      },
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.cfg.plugins?.slots?.contextEngine).toBe("lossless-claw");
    expect(result.cfg.plugins?.entries?.["lossless-claw"]).toEqual({ enabled: true, config: {} });
    expect(result.cfg.agents?.defaults?.compaction).toEqual({ keepRecentTokens: 10_000 });
  });

  it("migrates numeric string agent ids before treating the path label as an index", () => {
    const result = repairFixture({
      list: [
        { id: "other", model: "anthropic/claude-sonnet-4-6" },
        {
          id: "0",
          model: "openai/gpt-5.5",
          compaction: { model: "openai/gpt-5.4-mini", provider: "lossless-claw" },
        },
      ],
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.cfg.agents?.list?.[0]?.compaction).toBeUndefined();
    expect(result.cfg.agents?.list?.[1]?.compaction).toBeUndefined();
    expect(result.cfg.plugins?.entries?.["lossless-claw"]?.config).toEqual({
      summaryModel: "openai/gpt-5.4-mini",
    });
  });

  it("does not overwrite a non-Lossless context-engine slot", () => {
    const result = repairFixture({
      defaults: {
        model: "openai/gpt-5.5",
        compaction: {
          model: "openai-codex/gpt-5.4",
          provider: "lossless-claw",
        },
      },
      plugins: { slots: { contextEngine: "custom-context" } },
    });

    expect(result.cfg.agents?.defaults?.compaction).toEqual({
      model: "openai/gpt-5.4",
      provider: "lossless-claw",
    });
    expectModelRuntime(result.cfg.agents?.defaults?.models?.["openai/gpt-5.4"]);
    expectLosslessWarning(
      result.warnings,
      "agents.defaults.compaction.provider: lossless-claw",
      "agents.defaults.compaction.model: openai/gpt-5.4",
    );
  });

  it.each([false, true])(
    "preserves per-agent Lossless runtime policy when migration is blocked=%s",
    (blocked) => {
      const summary = "openai-codex/gpt-5.4-mini";
      const result = repairFixture({
        providers: { openai: openaiProvider(blocked ? {} : { agentRuntime: { id: "openclaw" } }) },
        ...(blocked ? { plugins: { slots: { contextEngine: "custom-context" } } } : {}),
        defaults: {
          model: blocked ? "anthropic/claude-sonnet-4-6" : "openai-codex/gpt-5.5",
          compaction: { model: summary, ...(!blocked ? { provider: "lossless-claw" } : {}) },
        },
        list: ["fast", "deep"].map((id) => ({
          id,
          model: "openai/gpt-5.5",
          models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
          compaction: blocked ? { provider: "lossless-claw" } : { model: summary },
        })),
      });
      expect(result.cfg.agents?.defaults?.compaction).toEqual(
        blocked ? { model: "openai/gpt-5.4-mini" } : undefined,
      );
      const agents = result.cfg.agents?.list;
      expect(agents?.map((agent) => agent.compaction)).toEqual(
        blocked
          ? [{ provider: "lossless-claw" }, { provider: "lossless-claw" }]
          : [undefined, undefined],
      );
      expectModelRuntime(agents?.[0]?.models?.["openai/gpt-5.4-mini"]);
      expectModelRuntime(agents?.[1]?.models?.["openai/gpt-5.4-mini"]);
      if (blocked) {
        expectLosslessWarning(
          result.warnings,
          "agents.list.fast.compaction.provider: lossless-claw",
          "agents.defaults.compaction.model: openai/gpt-5.4-mini",
          "agents.list.deep.compaction.provider: lossless-claw",
        );
      } else {
        expect(result.cfg.plugins?.slots?.contextEngine).toBe("lossless-claw");
        expect(result.cfg.plugins?.entries?.["lossless-claw"]?.config).toEqual({
          summaryModel: "openai/gpt-5.4-mini",
        });
      }
    },
  );

  it("keeps blocked namespace refs while repairing an independent namespace", () => {
    const result = repairFixture({
      defaults: { model: "openai-codex/gpt-5.6-sol" },
      providers: {
        openai: catalogProvider("gpt-5.6-sol", { api: "openai-responses" }),
        "openai-codex": catalogProvider("gpt-5.6-sol", { api: "openai-chatgpt-responses" }),
      },
      hooks: { mappings: [{ model: "codex/gpt-5.4-mini" }] },
    });

    expect(result.cfg.agents?.defaults?.model).toBe("openai-codex/gpt-5.6-sol");
    expect(result.cfg.hooks?.mappings?.[0]?.model).toBe("openai/gpt-5.4-mini");
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain(
      "Legacy Codex provider routes require manual reconciliation",
    );
  });

  it.each([undefined, "custom-summary"])(
    "preserves the host summary model during Codex repair (provider=%s)",
    (provider) => {
      const result = repairFixture({
        defaults: {
          model: "openai/gpt-5.5",
          compaction: {
            model: "anthropic/claude-sonnet-4-6",
            keepRecentTokens: 10_000,
            ...(provider ? { provider } : {}),
          },
        },
        plugins: { entries: { codex: { enabled: true } } },
      });

      expect(result.cfg.agents?.defaults?.compaction).toEqual({
        model: "anthropic/claude-sonnet-4-6",
        keepRecentTokens: 10_000,
      });
      expect(result.warnings).toEqual([]);
      expect(maybeRepairCodexRoutes(result.cfg).changes).toEqual([]);
    },
  );

  it("keeps doctor fix hint for agent-specific compaction overrides", () => {
    const warnings = collectCodexRouteWarnings(
      fixture({
        defaults: {
          model: "anthropic/claude-sonnet-4-6",
          compaction: { model: "openai/gpt-5.4", provider: "custom-summary" },
        },
        list: [
          {
            id: "codex",
            model: "openai/gpt-5.5",
            compaction: { model: "openai/gpt-5.4", provider: "agent-summary" },
          },
          { id: "inherited", model: "openai/gpt-5.5" },
          { id: "worker", model: "anthropic/claude-sonnet-4-6" },
        ],
      }),
    );

    expectWarnings(warnings, [
      [
        "Codex runtime ignores compaction.provider",
        "- agents.defaults.compaction.provider: custom-summary is ignored while this agent uses Codex runtime.",
        "- Move or remove shared `agents.defaults.compaction.provider` manually; doctor keeps shared defaults while non-Codex agents can inherit them.",
      ],
      [
        "Codex runtime ignores compaction.provider",
        "- agents.list.codex.compaction.provider: agent-summary is ignored while this agent uses Codex runtime.",
        "- Run `openclaw doctor --fix`: it removes unsupported Codex compaction overrides.",
      ],
    ]);
  });

  it("does not broaden runtime policy from kept compaction-only refs", () => {
    const result = repairFixture({
      defaults: {
        model: "openai-codex/gpt-5.5",
        heartbeat: { model: "openai/gpt-5.4" },
        compaction: { model: "openai-codex/gpt-5.4", provider: "custom-summary" },
      },
      providers: {
        openai: openaiProvider({
          baseUrl: "https://api.openai.com/v1",
          agentRuntime: { id: "openclaw" },
        }),
      },
      list: [{ id: "worker", model: "anthropic/claude-sonnet-4-6" }],
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
    const refs = (provider: string): RouteFixture => ({
      defaults: {
        model: {
          primary: `${provider}/gpt-5.5`,
          fallbacks: [`${provider}/gpt-5.4`, "anthropic/claude-sonnet-4-6"],
        },
        heartbeat: { model: `${provider}/gpt-5.4-mini` },
        subagents: {
          model: { primary: `${provider}/gpt-5.5`, fallbacks: [`${provider}/gpt-5.4`] },
        },
        compaction: { model: `${provider}/gpt-5.4` },
        models: { [`${provider}/gpt-5.5`]: { alias: "codex" } },
      },
      channels: { modelByChannel: { telegram: { default: `${provider}/gpt-5.4` } } },
      hooks: {
        mappings: [{ model: `${provider}/gpt-5.4-mini` }],
        gmail: { model: `${provider}/gpt-5.4` },
      },
      tts: { summaryModel: `${provider}/gpt-5.4-mini` },
      entries: { worker: { model: `${provider}/gpt-5.4` } },
    });
    const result = repairFixture(refs("openai-codex"));
    const expected = fixture(refs("openai"));
    expect(result.warnings).toStrictEqual([]);
    expect(result.cfg.agents).toEqual({
      defaults: {
        ...expected.agents?.defaults,
        models: {
          "openai/gpt-5.5": { alias: "codex", agentRuntime: { id: "codex" } },
          "openai/gpt-5.4": { agentRuntime: { id: "codex" } },
        },
      },
      entries: {
        worker: {
          model: "openai/gpt-5.4",
          models: { "openai/gpt-5.4": { agentRuntime: { id: "codex" } } },
        },
      },
    });
    expect(result.cfg.channels).toEqual(expected.channels);
    expect(result.cfg.hooks).toEqual(expected.hooks);
    expect(result.cfg.tts).toEqual(expected.tts);
  });

  it("warns without overriding an explicit Codex plugin opt-out", () => {
    const result = repairFixture({
      defaults: { model: { primary: "gpt-5.5" } },
      plugins: {
        allow: ["openai"],
        entries: { openai: { enabled: true }, codex: { enabled: false } },
      },
    });

    expectWarnings(result.warnings, [
      [
        "Codex plugin is disabled",
        "- agents.defaults.model.primary: gpt-5.5 resolves to openai/gpt-5.5 with Codex runtime while the Codex plugin is disabled by config.",
        "Enable plugins.entries.codex",
      ],
    ]);
    expect(result.changes).toStrictEqual([]);
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(false);
    expect(result.cfg.plugins?.allow).toEqual(["openai"]);
    expectAgentRuntime(result.cfg, "codex", { modelId: "gpt-5.5" });
  });

  it.each<RouteFixture & { name: string }>([
    {
      name: "inherited bare aliases",
      defaults: {
        model: "sonnet",
        models: {
          "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
          "claude-opus-4-6": { alias: "opus" },
        },
        subagents: { model: "opus" },
      },
    },
    {
      name: "implicit provider defaults",
      defaults: {},
      providers: { anthropic: catalogProvider("claude-sonnet-4-6") },
    },
    {
      name: "OpenRouter compat alias",
      defaults: { model: "router-auto", models: { "openrouter:auto": { alias: "router-auto" } } },
    },
    {
      name: "normalized runtime agent id",
      list: [
        {
          id: "",
          model: "gpt-5.5",
          models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
        },
      ],
    },
    {
      name: "case-insensitive provider model",
      defaults: { model: "qwen-max" },
      providers: { "qwen-dashscope": catalogProvider("Qwen-Max") },
    },
  ])("keeps Codex disabled for $name", ({ name: _name, ...config }) => {
    const result = repairFixture({ plugins: DISABLED_CODEX_PLUGIN_CONFIG, ...config });
    expect(result).toMatchObject({
      warnings: [],
      changes: [],
      cfg: { plugins: { entries: { codex: { enabled: false } } } },
    });
  });

  it("repairs live multi-agent Codex upgrade configs and enables Codex through allowlists", () => {
    const result = repairFixture({
      defaults: { model: "openai-codex/gpt-5.5" },
      plugins: {
        allow: ["brave", "discord", "whatsapp"],
        entries: Object.fromEntries(
          ["brave", "discord", "whatsapp"].map((id) => [id, { enabled: true }]),
        ),
      },
      list: ["main", "meimei", "youyou-cli"].map((id) => ({ id, model: "openai-codex/gpt-5.5" })),
    });

    expect(result.warnings).toStrictEqual([]);
    expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(result.cfg.agents?.list?.map((agent) => agent.model)).toEqual([
      "openai/gpt-5.5",
      "openai/gpt-5.5",
      "openai/gpt-5.5",
    ]);
    expectModelRuntime(result.cfg.agents?.defaults?.models?.["openai/gpt-5.5"]);
    for (const agent of result.cfg.agents?.list ?? []) {
      expect(agent.models?.["openai/gpt-5.5"]?.agentRuntime).toEqual({ id: "codex" });
    }
    expect(result.cfg.plugins?.entries?.codex?.enabled).toBe(true);
    expect(result.cfg.plugins?.allow).toEqual(["brave", "discord", "whatsapp", "codex"]);
  });

  it("preserves inherited default wildcard runtime pins for listed-agent legacy refs", () => {
    const cfg = fixture({
      defaults: {
        models: {
          "openai-codex/*": { agentRuntime: { id: "openclaw" } },
        },
      },
      list: [{ id: "worker", model: "openai-codex/gpt-5.4" }],
    }) satisfies OpenClawConfigWithLegacyRoster;

    expectAgentRuntime(cfg, "openclaw", { provider: "openai-codex", agentId: "worker" });

    const result = maybeRepairCodexRoutes(cfg);

    expectModelRuntime(result.cfg.agents?.defaults?.models?.["openai/*"], "openclaw");
    expect(result.cfg.agents?.defaults?.models?.["openai-codex/*"]).toBeUndefined();
    expect(result.cfg.agents?.list?.[0]?.model).toBe("openai/gpt-5.4");
    expect(result.cfg.agents?.list?.[0]?.models?.["openai/gpt-5.4"]).toBeUndefined();
    expectAgentRuntime(result.cfg, "openclaw", { agentId: "worker" });
  });

  it.each(["catalog", "provider"])(
    "preserves legacy %s runtime pins without broadening canonical agents",
    (source) => {
      const providerPin = source === "provider";
      const cfg = fixture({
        defaults: { model: "openai-codex/gpt-5.4" },
        providers: {
          "openai-codex": providerPin
            ? { baseUrl: "", models: [], agentRuntime: { id: "openclaw" } }
            : catalogProvider("gpt-5.4", { agentRuntime: { id: "openclaw" } }),
        },
        ...(providerPin
          ? {
              list: [
                { id: "main", default: true },
                { id: "regular", model: "openai/gpt-5.4" },
              ],
            }
          : {}),
      });
      const owner = providerPin ? { agentId: "main" } : {};
      expectAgentRuntime(cfg, "openclaw", { provider: "openai-codex", ...owner });
      if (providerPin) {
        expectAgentRuntime(cfg, "codex", { agentId: "regular" });
      }
      const result = maybeRepairCodexRoutes(cfg);
      expect(result.cfg.agents?.defaults?.model).toBe("openai/gpt-5.4");
      expectModelRuntime(result.cfg.agents?.defaults?.models?.["openai/gpt-5.4"], "openclaw");
      expectAgentRuntime(result.cfg, "openclaw", owner);
      if (providerPin) {
        expect(result.cfg.agents?.list?.[0]?.model).toBeUndefined();
        expect(result.cfg.agents?.list?.[1]?.model).toBe("openai/gpt-5.4");
        expectModelRuntime(result.cfg.agents?.list?.[1]?.models?.["openai/gpt-5.4"]);
        expectAgentRuntime(result.cfg, "codex", { agentId: "regular" });
      }
    },
  );

  it("leaves path-scoped agent refs unchanged when repair would broaden another canonical agent slot", () => {
    const result = repairFixture({
      defaults: {
        model: { primary: "openai/gpt-5.4" },
        heartbeat: { model: "openai-codex/gpt-5.4" },
      },
      providers: {
        openai: openaiProvider({
          baseUrl: "https://api.openai.com/v1",
          agentRuntime: { id: "openclaw" },
        }),
      },
    });

    expect(result.cfg.agents?.defaults?.model).toEqual({ primary: "openai/gpt-5.4" });
    expect(result.cfg.agents?.defaults?.heartbeat?.model).toBe("openai-codex/gpt-5.4");
    expect(result.cfg.agents?.defaults?.models).toBeUndefined();
    expectAgentRuntime(result.cfg, "openclaw");
    expect(result.changes).toStrictEqual([]);
    expectWarnings(result.warnings, [
      [
        "Legacy `codex/*` and `openai-codex/*`",
        "- agents.defaults.heartbeat.model: openai-codex/gpt-5.4 should become openai/gpt-5.4.",
        "openclaw doctor --fix",
      ],
    ]);
  });

  it("preserves an explicit legacy runtime pin over canonical default during model-map migration", () => {
    const result = repairFixture({
      defaults: {
        model: { primary: "openai-codex/gpt-5.4" },
        models: {
          "openai-codex/gpt-5.4": { agentRuntime: { id: "openclaw" } },
          "openai/gpt-5.4": { alias: "canonical-codex", agentRuntime: { id: "default" } },
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
});
