import { describe, expect, it } from "vitest";
import { resolveModelRuntimePolicy } from "../../../agents/model-runtime-policy.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveModelEntries } from "../../../media-understanding/resolve.js";
import { normalizeLegacyRuntimeModelRefs } from "./legacy-config-core-normalizers.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";

describe("canonical model-reference migration", () => {
  it.each(["defaults", "entries", "list"] as const)(
    "preserves execution-only runtime selections in agents.%s",
    (scope) => {
      const agent = {
        model: "openai/current-model",
        heartbeat: { model: "claude-cli/heartbeat-only", every: "2h" },
        subagents: {
          model: {
            primary: "google-gemini-cli/subagent-only",
            fallbacks: ["claude-cli/subagent-fallback"],
          },
        },
      };
      const config: OpenClawConfig = {
        agents:
          scope === "defaults"
            ? { defaults: agent, entries: { main: {} } }
            : scope === "entries"
              ? { entries: { main: agent } }
              : { list: [{ id: "main", ...agent }] },
      };

      const result = normalizeLegacyRuntimeModelRefs(config, []);
      const migrated =
        scope === "defaults"
          ? result.agents?.defaults
          : scope === "entries"
            ? result.agents?.entries?.main
            : result.agents?.list?.[0];

      expect(migrated?.heartbeat).toEqual({ model: "anthropic/heartbeat-only", every: "2h" });
      expect(migrated?.subagents?.model).toEqual({
        primary: "google/subagent-only",
        fallbacks: ["anthropic/subagent-fallback"],
      });
      expect(migrated?.models).toEqual({
        "anthropic/heartbeat-only": { agentRuntime: { id: "claude-cli" } },
        "google/subagent-only": { agentRuntime: { id: "google-gemini-cli" } },
        "anthropic/subagent-fallback": { agentRuntime: { id: "claude-cli" } },
      });
      expect(
        resolveModelRuntimePolicy({
          config: result,
          agentId: "main",
          provider: "anthropic",
          modelId: "heartbeat-only",
        }).policy?.id,
      ).toBe("claude-cli");
      expect(
        resolveModelRuntimePolicy({
          config: result,
          agentId: "main",
          provider: "google",
          modelId: "subagent-only",
        }).policy?.id,
      ).toBe("google-gemini-cli");
      const repeatedChanges: string[] = [];
      expect(normalizeLegacyRuntimeModelRefs(result, repeatedChanges)).toEqual(result);
      expect(repeatedChanges).toEqual([]);
      expect(agent.heartbeat.model).toBe("claude-cli/heartbeat-only");
    },
  );

  it("keeps explicit canonical runtime policies for execution-only selections", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          heartbeat: { model: "claude-cli/heartbeat-only" },
          subagents: { model: "google-gemini-cli/subagent-only" },
          models: {
            "anthropic/heartbeat-only": { alias: "Heartbeat", agentRuntime: { id: "openclaw" } },
            "google/subagent-only": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
    };

    const result = normalizeLegacyRuntimeModelRefs(config, []);

    expect(result.agents?.defaults?.heartbeat?.model).toBe("anthropic/heartbeat-only");
    expect(result.agents?.defaults?.subagents?.model).toBe("google/subagent-only");
    expect(result.agents?.defaults?.models).toEqual(config.agents?.defaults?.models);
  });

  it("preserves provider-local model IDs and their matching media preference", () => {
    const config: OpenClawConfig = {
      tools: {
        media: {
          audio: { preferredModel: "openai/claude-cli/team/model" },
          models: [
            { provider: "openai", model: "other-model", capabilities: ["audio"] },
            { provider: "openai", model: "claude-cli/team/model", capabilities: ["audio"] },
          ],
        },
      },
    };

    const result = normalizeLegacyRuntimeModelRefs(config, []);

    expect(result).toEqual(config);
    expect(
      resolveModelEntries({
        cfg: result,
        capability: "audio",
        config: result.tools?.media?.audio,
        providerRegistry: new Map(),
      })[0]?.entry,
    ).toMatchObject({ provider: "openai", model: "claude-cli/team/model" });
  });

  it("migrates an identified legacy media provider/model pair together", () => {
    const config: OpenClawConfig = {
      tools: {
        media: {
          audio: { preferredModel: "google-gemini-cli/gemini-3.1-pro-preview" },
          models: [
            {
              provider: "google-gemini-cli",
              model: "gemini-3.1-pro-preview",
              capabilities: ["audio"],
            },
          ],
        },
      },
    };

    const result = normalizeLegacyRuntimeModelRefs(config, []);

    expect(result.tools?.media).toEqual({
      audio: { preferredModel: "google/gemini-3.1-pro-preview" },
      models: [{ provider: "google", model: "gemini-3.1-pro-preview", capabilities: ["audio"] }],
    });
  });

  it("repairs a retired preferred audio model without discarding the preference", () => {
    const result = migrateLegacyConfig({
      plugins: { enabled: false },
      tools: {
        media: {
          audio: { preferredModel: "google/gemini-3-pro-preview" },
          models: [
            { provider: "google", model: "gemini-3.1-pro-preview", capabilities: ["audio"] },
          ],
        },
      },
    });

    expect(result.config?.tools?.media?.audio?.preferredModel).toBe(
      "google/gemini-3.1-pro-preview",
    );
    expect(result.partiallyValid).not.toBe(true);
    expect(result.config?.tools?.media?.models).toEqual([
      { provider: "google", model: "gemini-3.1-pro-preview", capabilities: ["audio"] },
    ]);
    expect(migrateLegacyConfig(result.sourceConfig ?? result.config).changes).toEqual([]);
  });

  it.each(["cli:fixture-transcriber", "custom/team/model@account"])(
    "preserves the authored preferred model %s while repairing another slot",
    (preferredModel) => {
      const result = migrateLegacyConfig({
        plugins: { enabled: false },
        agents: { defaults: { model: "google/gemini-3-pro-preview" } },
        tools: { media: { audio: { preferredModel } } },
      });

      expect(result.config?.tools?.media?.audio?.preferredModel).toBe(preferredModel);
      expect(result.config?.agents?.defaults?.model).toBe("google/gemini-3.1-pro-preview");
    },
  );

  it("migrates mixed runtime fallbacks and preserves each runtime separately", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "openai/current-model",
            fallbacks: ["claude-cli/assistant-a", "google-gemini-cli/assistant-b"],
          },
        },
      },
    };
    const result = normalizeLegacyRuntimeModelRefs(config, []);

    expect(result.agents?.defaults?.model).toEqual({
      primary: "openai/current-model",
      fallbacks: ["anthropic/assistant-a", "google/assistant-b"],
    });
    expect(result.agents?.defaults?.models).toEqual({
      "anthropic/assistant-a": { agentRuntime: { id: "claude-cli" } },
      "google/assistant-b": { agentRuntime: { id: "google-gemini-cli" } },
    });
    expect(config.agents?.defaults?.models).toBeUndefined();
  });

  it("retires unselected legacy keys without losing nested authored fields", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: "openai/current-model",
          models: {
            "claude-cli/assistant-a": {
              alias: "Legacy alias",
              params: { temperature: 0.3, maxTokens: 1200 },
            },
            "anthropic/assistant-a": {
              alias: "Canonical alias",
              params: { temperature: 0.8 },
              agentRuntime: { id: "openclaw" },
            },
          },
        },
      },
    };
    const changes: string[] = [];
    const result = normalizeLegacyRuntimeModelRefs(config, changes);

    expect(result.agents?.defaults?.models).toEqual({
      "anthropic/assistant-a": {
        alias: "Canonical alias",
        params: { temperature: 0.8, maxTokens: 1200 },
        agentRuntime: { id: "openclaw" },
      },
    });
    expect(result.agents?.defaults?.model).toBe("openai/current-model");
    expect(changes).not.toEqual([]);
    const secondChanges: string[] = [];
    expect(normalizeLegacyRuntimeModelRefs(result, secondChanges)).toEqual(result);
    expect(secondChanges).toEqual([]);
  });

  it("keeps profile suffixes and preserves an explicit canonical runtime", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: "claude-cli/assistant-a@personal:account",
          models: {
            "anthropic/assistant-a@personal:account": {
              alias: "Personal",
              agentRuntime: { id: "openclaw" },
            },
          },
        },
      },
    };
    const result = normalizeLegacyRuntimeModelRefs(config, []);

    expect(result.agents?.defaults?.model).toBe("anthropic/assistant-a@personal:account");
    expect(result.agents?.defaults?.models).toEqual({
      "anthropic/assistant-a@personal:account": {
        alias: "Personal",
        agentRuntime: { id: "openclaw" },
      },
    });
  });

  it("repairs runtime references in media selections without rewriting custom namespaced IDs", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          imageModel: {
            primary: "google-gemini-cli/vision-model",
            fallbacks: ["custom/team/google-gemini-cli/vision-model"],
          },
        },
      },
    };
    const result = normalizeLegacyRuntimeModelRefs(config, []);

    expect(result.agents?.defaults?.imageModel).toEqual({
      primary: "google/vision-model",
      fallbacks: ["custom/team/google-gemini-cli/vision-model"],
    });
  });

  it("uses the same migration for image, video, and music model slots", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          mediaModels: {
            image: "google-gemini-cli/image-model",
            video: "google-gemini-cli/video-model",
            music: "google-gemini-cli/music-model",
          },
        },
      },
    };

    expect(normalizeLegacyRuntimeModelRefs(config, []).agents?.defaults?.mediaModels).toEqual({
      image: "google/image-model",
      video: "google/video-model",
      music: "google/music-model",
    });
  });

  it("removes blocked nested fields when legacy and canonical model entries collide", () => {
    const config = JSON.parse(`{
      "agents": {"defaults": {"models": {
        "claude-cli/assistant-a": {
          "params": {"maxTokens": 1200, "constructor": {"polluted": true}}
        },
        "anthropic/assistant-a": {
          "params": {"temperature": 0.8, "__proto__": {"polluted": true}}
        }
      }}}
    }`);

    expect(normalizeLegacyRuntimeModelRefs(config, []).agents?.defaults?.models).toEqual({
      "anthropic/assistant-a": {
        params: { temperature: 0.8, maxTokens: 1200 },
        agentRuntime: { id: "claude-cli" },
      },
    });
    expect(Reflect.get(Object.prototype, "polluted")).toBeUndefined();
  });
});
