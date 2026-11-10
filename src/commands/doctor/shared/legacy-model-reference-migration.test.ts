import { describe, expect, it, vi } from "vitest";
import { resolveModelRuntimePolicy } from "../../../agents/model-runtime-policy.js";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import { normalizeCompatibilityConfigValues } from "./legacy-config-core-migrate.js";
import { normalizeLegacyRuntimeModelRefs as normalizeRefs } from "./legacy-config-core-normalizers.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

type AgentDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;

const defaults = (value: AgentDefaults): OpenClawConfig => ({ agents: { defaults: value } });

function runtime(config: OpenClawConfig, provider: string, modelId: string, agentId?: string) {
  return resolveModelRuntimePolicy({ config, provider, modelId, agentId }).policy;
}

const audioModel = "gemini-3.1-pro-preview";

function audio(preferredModel: string, provider = "google"): OpenClawConfig {
  return {
    tools: {
      media: {
        audio: { preferredModel },
        models: [{ provider, model: audioModel, capabilities: ["audio"] }],
      },
    },
  };
}

const migrate = (raw: unknown) => migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
const selection = (primary: string, ...fallbacks: string[]) => ({ primary, fallbacks });
const mediaModels = (provider: string) => ({
  image: `${provider}/image-model`,
  video: `${provider}/video-model`,
  music: `${provider}/music-model`,
});

function expectIdempotent(config: OpenClawConfigWithLegacyRoster) {
  const changes: string[] = [];
  expect(normalizeRefs(config, changes, [])).toEqual(config);
  expect(changes).toEqual([]);
}

describe("canonical model-reference migration", () => {
  it.each(["defaults", "list"] as const)(
    "preserves execution-only runtime selections in agents.%s",
    (scope) => {
      const agent = {
        model: selection("openai/current-model", "claude-cli/primary-fallback"),
        heartbeat: { model: "claude-cli/heartbeat-only", every: "2h" },
        subagents: { model: selection("google-gemini-cli/subagent", "claude-cli/fallback") },
      };
      const config: OpenClawConfigWithLegacyRoster = {
        agents:
          scope === "defaults"
            ? { defaults: agent, entries: { main: {} } }
            : { list: [{ id: "main", ...agent }] },
      };

      const result = normalizeRefs(config, [], []);
      const migrated = scope === "defaults" ? result.agents?.defaults : result.agents?.list?.[0];

      expect(migrated?.model).toEqual(
        selection("openai/current-model", "anthropic/primary-fallback"),
      );
      expect(migrated?.heartbeat).toEqual({ model: "anthropic/heartbeat-only", every: "2h" });
      expect(migrated?.subagents?.model).toEqual(
        selection("google/subagent", "anthropic/fallback"),
      );
      expect(migrated?.models).toEqual({
        "anthropic/primary-fallback": { agentRuntime: { id: "claude-cli" } },
        "anthropic/heartbeat-only": { agentRuntime: { id: "claude-cli" } },
        "google/subagent": { agentRuntime: { id: "google-gemini-cli" } },
        "anthropic/fallback": { agentRuntime: { id: "claude-cli" } },
      });
      expect(runtime(result, "anthropic", "heartbeat-only", "main")?.id).toBe("claude-cli");
      expect(runtime(result, "google", "subagent", "main")?.id).toBe("google-gemini-cli");
      expectIdempotent(result);
      expect(agent.heartbeat.model).toBe("claude-cli/heartbeat-only");
    },
  );

  it("migrates an identified legacy media provider/model pair together", () => {
    const config = audio(`google-gemini-cli/${audioModel}`, "google-gemini-cli");
    const result = normalizeRefs(config, [], []);
    expect(result.tools?.media).toEqual(audio(`google/${audioModel}`).tools?.media);
  });

  it("repairs a retired preferred audio model without discarding the preference", () => {
    const result = migrate({
      plugins: { enabled: false },
      ...audio("google/gemini-3-pro-preview"),
    });

    expect(result.config?.tools?.media).toEqual(audio(`google/${audioModel}`).tools?.media);
    expect(result.partiallyValid).not.toBe(true);
    expect(migrate(result.sourceConfig ?? result.config).changes).toEqual([]);
  });

  it.each(["cli:fixture-transcriber", "custom/team/model@account"])(
    "preserves the authored preferred model %s while repairing another slot",
    (preferredModel) => {
      const raw = {
        plugins: { enabled: false },
        agents: { defaults: { model: "google/gemini-3-pro-preview" } },
        tools: { media: { audio: { preferredModel } } },
      };
      const result = migrate(raw);

      expect(result.config?.tools?.media?.audio?.preferredModel).toBe(preferredModel);
      expect(result.config?.agents?.defaults?.model).toBe("google/gemini-3.1-pro-preview");
    },
  );

  it("uses the same migration for image, video, and music model slots", () => {
    const config = defaults({ mediaModels: mediaModels("google-gemini-cli") });
    expect(normalizeRefs(config, [], []).agents?.defaults?.mediaModels).toEqual(
      mediaModels("google"),
    );
  });

  it("merges unselected model entries without losing authored fields or retaining blocked keys", () => {
    const config = defaults({
      model: "openai/current-model",
      models: {
        "claude-cli/assistant-a": {
          alias: "Legacy alias",
          params: { temperature: 0.3, maxTokens: 1200, constructor: { polluted: true } },
        },
        "anthropic/assistant-a": {
          alias: "Canonical alias",
          params: { temperature: 0.8, ["__proto__"]: { polluted: true } },
          agentRuntime: { id: "claude-cli" },
        },
      },
    });
    const changes: string[] = [];
    const result = normalizeRefs(config, changes, []);
    expect(result.agents?.defaults?.models).toEqual({
      "anthropic/assistant-a": {
        alias: "Canonical alias",
        params: { temperature: 0.8, maxTokens: 1200 },
        agentRuntime: { id: "claude-cli" },
      },
    });
    expect(Reflect.get(Object.prototype, "polluted")).toBeUndefined();
    expect(result.agents?.defaults?.model).toBe("openai/current-model");
    expect(changes).not.toEqual([]);
    expectIdempotent(result);
  });

  const opusApi = { agentRuntime: { id: "openclaw" } };
  const [api5, cli5] = ["anthropic/claude-opus-5", "claude-cli/claude-opus-5"];
  const [api, cli] = ["anthropic/claude-opus-4-7", "claude-cli/claude-opus-4-7"];
  const entries = (value: Record<string, unknown>) =>
    ({ agents: { entries: value } }) as OpenClawConfig;
  const pinnedElsewhere = {
    model: selection(cli5, api5),
    models: { [api5]: opusApi, [cli5]: { alias: "opus-sub" } },
    modelPolicy: { allow: ["anthropic/*", "claude-cli/*"] },
  };
  it.each<[string, OpenClawConfigWithLegacyRoster]>([
    ["a defaults pin to another runtime (#191149)", defaults(pinnedElsewhere)],
    ["an agent pin to another runtime", entries({ main: pinnedElsewhere })],
    [
      "an agent pin behind a matching defaults pin",
      {
        agents: {
          defaults: { models: { [api5]: { agentRuntime: { id: "claude-cli" } } } },
          entries: { main: { model: cli5, models: { [api5]: opusApi } } },
        },
      },
    ],
    [
      "a wildcard-only legacy allowlist",
      defaults({ models: { [api5]: opusApi }, modelPolicy: { allow: ["claude-cli/*"] } }),
    ],
    [
      "a profile-qualified selector",
      defaults({ model: `${cli5}@personal`, models: { [api5]: opusApi } }),
    ],
    [
      "a provider-spelled pin key",
      defaults({ model: cli5, models: { "Anthropic/claude-opus-5": opusApi } }),
    ],
    ["a provider wildcard pin", defaults({ model: cli5, models: { "anthropic/*": opusApi } })],
    ["a bare model pin", defaults({ model: cli5, models: { "claude-opus-5": opusApi } })],
    [
      "a model-prefix legacy allowlist",
      defaults({
        model: api5,
        models: { [api5]: opusApi },
        modelPolicy: { allow: ["anthropic/*", "claude-cli/claude-opus-*"] },
      }),
    ],
    [
      "a provider runtime",
      {
        ...defaults({ model: cli5 }),
        models: {
          providers: {
            anthropic: { baseUrl: "https://api.anthropic.com", models: [], ...opusApi },
          },
        },
      },
    ],
    ["an API primary with a CLI fallback", defaults({ model: selection(api, cli) })],
    ["a CLI primary with an API fallback", defaults({ model: selection(cli, api) })],
    ["an agent API primary with a CLI fallback", entries({ main: { model: selection(api, cli) } })],
    [
      "a subagent API primary with a CLI fallback",
      defaults({ subagents: { model: selection(api, cli) } }),
    ],
    ["a CLI subagent beside an API primary", defaults({ model: api, subagents: { model: cli } })],
    ["a CLI heartbeat beside an API primary", defaults({ model: api, heartbeat: { model: cli } })],
    ["an agent CLI heartbeat", entries({ work: { model: api, heartbeat: { model: cli } } })],
    [
      "an agent CLI heartbeat beside an inherited API primary",
      { agents: { defaults: { model: api }, entries: { w: { heartbeat: { model: cli } } } } },
    ],
    [
      "a defaults CLI heartbeat beside an agent API primary",
      { agents: { defaults: { heartbeat: { model: cli } }, list: [{ id: "w", model: api }] } },
    ],
    [
      "a model map with both spellings",
      defaults({ model: api, models: { [api]: { alias: "API" }, [cli]: {} } }),
    ],
    [
      "an allowlist with both spellings",
      defaults({ model: api, modelPolicy: { allow: [api, cli] } }),
    ],
    [
      "a Gemini CLI subagent beside a Google primary",
      defaults({
        model: "google/gemini-pro",
        subagents: { model: "google-gemini-cli/gemini-pro" },
      }),
    ],
  ])("keeps legacy CLI refs beside %s", (_case, config) => {
    const changes: string[] = [];
    const warnings: string[] = [];
    expect(normalizeRefs(config, changes, warnings)).toEqual(config);
    expect([changes, warnings]).toEqual([
      [],
      [expect.stringMatching(/^Kept legacy .*-cli\/\* model refs: /)],
    ]);
  });

  // [case, config, agent whose API route stays unpinned, agent whose CLI route resolves]
  it.each<[string, OpenClawConfigWithLegacyRoster, string?, string?]>([
    [
      "another model",
      defaults({ model: api, heartbeat: { model: "claude-cli/claude-sonnet-5" } }),
      "main",
    ],
    [
      "a CLI-pinned canonical model",
      defaults({
        model: api,
        models: { [api]: { agentRuntime: { id: "claude-cli" } } },
        heartbeat: { model: cli },
      }),
      undefined,
      "main",
    ],
    ["separate agents", entries({ api: { model: api }, cli: { model: cli } }), "api", "cli"],
  ])("migrates Claude CLI refs beside %s", (_case, config, apiAgent, cliAgent) => {
    const warnings: string[] = [];
    const result = normalizeRefs(config, [], warnings);
    expect(warnings).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("claude-cli/");
    const routes = ([[apiAgent], [cliAgent, "claude-cli"]] as const).filter(([agent]) => agent);
    for (const [agentId, id] of routes) {
      expect(runtime(result, "anthropic", "claude-opus-4-7", agentId)?.id).toBe(id);
    }
  });

  it("migrates Claude CLI refs when no pin routes Anthropic models elsewhere", () => {
    const config = defaults({
      model: "claude-cli/claude-opus-5",
      models: {
        "anthropic/claude-sonnet-5": { agentRuntime: { id: "claude-cli" } },
        "anthropic/claude-haiku-5": { agentRuntime: { id: "auto" } },
        "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
      },
    });
    const warnings: string[] = [];
    const result = normalizeRefs(config, [], warnings);

    expect(result.agents?.defaults?.model).toBe("anthropic/claude-opus-5");
    expect(runtime(result, "anthropic", "claude-opus-5")?.id).toBe("claude-cli");
    expect(warnings).toEqual([]);
  });

  it("keeps Claude CLI routes for legacy refs selected outside agent scopes", () => {
    const config: OpenClawConfig = {
      ...defaults({ model: "openai/gpt-5.5" }),
      hooks: { mappings: [{ model: "claude-cli/claude-sonnet-4-6" }] },
      channels: { modelByChannel: { discord: { "123": "claude-cli/claude-opus-4-7" } } },
    };
    const result = normalizeRefs(config, [], []);

    expect(result.hooks?.mappings?.[0]?.model).toBe("anthropic/claude-sonnet-4-6");
    expect(result.channels?.modelByChannel?.discord?.["123"]).toBe("anthropic/claude-opus-4-7");
    for (const model of ["claude-sonnet-4-6", "claude-opus-4-7"]) {
      expect(runtime(result, "anthropic", model, "main")?.id).toBe("claude-cli");
    }
    expectIdempotent(result);
  });

  it("keeps an outside legacy ref when an agent selects the same model directly", () => {
    const config: OpenClawConfig = {
      ...defaults({ model: "anthropic/claude-opus-4-7" }),
      channels: { modelByChannel: { discord: { "123": "claude-cli/claude-opus-4-7" } } },
    };
    const warnings: string[] = [];
    const result = normalizeRefs(config, [], warnings);

    expect(result.channels?.modelByChannel?.discord?.["123"]).toBe("claude-cli/claude-opus-4-7");
    expect(runtime(result, "anthropic", "claude-opus-4-7", "main")?.id).not.toBe("claude-cli");
    expect(warnings).toEqual([expect.stringMatching(/claude-opus-4-7 both directly/)]);
  });

  it("still migrates other legacy CLI providers beside a retained Claude CLI route", () => {
    const config = defaults({
      model: selection("claude-cli/claude-opus-5", "google-gemini-cli/gemini-pro"),
      models: { "anthropic/claude-opus-5": { agentRuntime: { id: "openclaw" } } },
    });
    const warnings: string[] = [];
    const result = normalizeRefs(config, [], warnings);

    expect(result.agents?.defaults?.model).toEqual(
      selection("claude-cli/claude-opus-5", "google/gemini-pro"),
    );
    expect(result.agents?.defaults?.models).toEqual({
      "anthropic/claude-opus-5": { agentRuntime: { id: "openclaw" } },
      "google/gemini-pro": { agentRuntime: { id: "google-gemini-cli" } },
    });
    expect(warnings).toHaveLength(1);
  });

  it("keeps both selected routes through the complete Doctor normalization pass", async () => {
    const model = selection("anthropic/claude-opus-4-7", "claude-cli/claude-opus-4-7");
    const raw = defaults({ model });
    const seeded = applyLegacyDoctorMigrations(raw, { sourceConfigBeforeMigrations: raw });
    const result = await normalizeCompatibilityConfigValues(seeded.next ?? raw);
    expect(result.config.agents?.defaults?.model).toEqual(model);
    expect(runtime(result.config, "anthropic", "claude-opus-4-7")?.id).not.toBe("claude-cli");
  });

  it("canonicalizes a seeded legacy Claude CLI allowlist in one doctor pass", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_OAUTH_TOKEN", "");
    // #124952: the seeded allowlist and its model map must migrate in one pass.
    const raw = defaults({
      model: { primary: "anthropic/claude-opus-4-7" },
      models: { "claude-cli/claude-opus-4-7": {}, "claude-cli/claude-sonnet-4-6": {} },
    });
    const seeded = applyLegacyDoctorMigrations(raw, { sourceConfigBeforeMigrations: raw });
    expect(seeded.next).toHaveProperty("agents.defaults.modelPolicy.allow", [
      "claude-cli/claude-opus-4-7",
      "claude-cli/claude-sonnet-4-6",
    ]);

    const res = await normalizeCompatibilityConfigValues(seeded.next);
    expect(res.config.agents?.defaults?.models).toEqual({
      "anthropic/*": { agentRuntime: { id: "claude-cli" } },
      "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
      "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
    });
    expect(runtime(res.config, "anthropic", "unseeded-claude-model")).toEqual({ id: "claude-cli" });
    expect(res.config.agents?.defaults?.modelPolicy).toEqual({
      allow: ["anthropic/claude-opus-4-7", "anthropic/claude-sonnet-4-6"],
    });
    expect((await normalizeCompatibilityConfigValues(res.config)).changes).toEqual([]);
  });
});
