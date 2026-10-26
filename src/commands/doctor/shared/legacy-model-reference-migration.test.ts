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
  expect(normalizeRefs(config, changes)).toEqual(config);
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

      const result = normalizeRefs(config, []);
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
    const result = normalizeRefs(config, []);
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
    expect(normalizeRefs(config, []).agents?.defaults?.mediaModels).toEqual(mediaModels("google"));
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
          agentRuntime: { id: "openclaw" },
        },
      },
    });
    const changes: string[] = [];
    const result = normalizeRefs(config, changes);
    expect(result.agents?.defaults?.models).toEqual({
      "anthropic/assistant-a": {
        alias: "Canonical alias",
        params: { temperature: 0.8, maxTokens: 1200 },
        agentRuntime: { id: "openclaw" },
      },
    });
    expect(Reflect.get(Object.prototype, "polluted")).toBeUndefined();
    expect(result.agents?.defaults?.model).toBe("openai/current-model");
    expect(changes).not.toEqual([]);
    expectIdempotent(result);
  });

  it("canonicalizes a seeded legacy Claude CLI allowlist in one doctor pass", () => {
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

    const res = normalizeCompatibilityConfigValues(seeded.next);
    expect(res.config.agents?.defaults?.models).toEqual({
      "anthropic/*": { agentRuntime: { id: "claude-cli" } },
      "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
      "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
    });
    expect(runtime(res.config, "anthropic", "unseeded-claude-model")).toEqual({ id: "claude-cli" });
    expect(res.config.agents?.defaults?.modelPolicy).toEqual({
      allow: ["anthropic/claude-opus-4-7", "anthropic/claude-sonnet-4-6"],
    });
    expect(normalizeCompatibilityConfigValues(res.config).changes).toEqual([]);
  });
});
