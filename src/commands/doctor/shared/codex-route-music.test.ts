import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { rewriteConfigModelRefs } from "./codex-route-config-repair.js";
import { collectConfigModelRefs } from "./codex-route-config-scan.js";

describe("Codex music model migration", () => {
  it.each(["codex", "openai-codex"])(
    "detects and repairs a scalar %s music reference",
    (provider) => {
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        agents: {
          defaults: {
            model: "openai/current-model",
            mediaModels: { music: `${provider}/gpt-5.4` },
          },
        },
      };
      const before = structuredClone(cfg);

      const detected = collectConfigModelRefs(cfg);
      const repaired = rewriteConfigModelRefs({ cfg });

      expect(detected).toEqual([
        {
          path: "agents.defaults.mediaModels.music",
          model: `${provider}/gpt-5.4`,
          canonicalModel: "openai/gpt-5.4",
        },
      ]);
      expect(repaired.changes).toEqual(detected);
      expect(repaired.cfg.agents?.defaults?.mediaModels?.music).toBe("openai/gpt-5.4");
      expect(collectConfigModelRefs(repaired.cfg)).toEqual([]);
      expect(rewriteConfigModelRefs({ cfg: repaired.cfg }).cfg).toBe(repaired.cfg);
      expect(cfg).toEqual(before);
    },
  );

  it("preserves fallback order, suffixes and explicit canonical settings", () => {
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: {
        defaults: {
          model: "openai/current-model",
          mediaModels: {
            music: {
              primary: "openai-codex/gpt-5.4@authored:music",
              fallbacks: [
                "codex/gpt-5.5",
                "custom/team/song@authored:backup",
                "openai/codex/team/music",
              ],
            },
          },
          models: {
            "openai/gpt-5.4@authored:music": {
              alias: "Authored music choice",
              agentRuntime: { id: "openclaw" },
            },
          },
        },
      },
    };

    const repaired = rewriteConfigModelRefs({ cfg });

    expect(repaired.cfg.agents?.defaults?.mediaModels?.music).toEqual({
      primary: "openai/gpt-5.4@authored:music",
      fallbacks: ["openai/gpt-5.5", "custom/team/song@authored:backup", "openai/codex/team/music"],
    });
    expect(repaired.cfg.agents?.defaults?.models).toEqual(cfg.agents?.defaults?.models);
    expect(repaired.changes).toEqual(collectConfigModelRefs(cfg));
    expect(repaired.changes.map((hit) => hit.path)).toEqual([
      "agents.defaults.mediaModels.music.primary",
      "agents.defaults.mediaModels.music.fallbacks.0",
    ]);
    expect(rewriteConfigModelRefs({ cfg: repaired.cfg }).changes).toEqual([]);
  });

  it.each(["openai-codex\0", "openai-codex\0gpt-5.4"])(
    "preserves a blocked music selection while repairing an unblocked fallback (%j)",
    (blockedIdentity) => {
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        agents: {
          defaults: {
            model: "openai/current-model",
            mediaModels: {
              music: {
                primary: "openai-codex/gpt-5.4@authored:music",
                fallbacks: ["codex/gpt-5.5", "custom/team/music"],
              },
            },
          },
        },
      };
      const blockedModelIdentities = new Set([blockedIdentity]);

      const repaired = rewriteConfigModelRefs({ cfg, blockedModelIdentities });

      expect(repaired.cfg.agents?.defaults?.mediaModels?.music).toEqual({
        primary: "openai-codex/gpt-5.4@authored:music",
        fallbacks: ["openai/gpt-5.5", "custom/team/music"],
      });
      expect(repaired.changes).toEqual(collectConfigModelRefs(cfg, blockedModelIdentities));
      expect(repaired.changes.map((hit) => hit.path)).toEqual([
        "agents.defaults.mediaModels.music.fallbacks.0",
      ]);
      expect(collectConfigModelRefs(repaired.cfg, blockedModelIdentities)).toEqual([]);
    },
  );

  it("keeps music detection and writing aligned with image and video", () => {
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: {
        defaults: {
          model: "openai/current-model",
          mediaModels: {
            image: "openai-codex/gpt-5.4",
            video: { primary: "codex/gpt-5.5" },
            music: { fallbacks: ["openai-codex/gpt-5.4", "custom/team/music"] },
          },
        },
      },
    };

    const repaired = rewriteConfigModelRefs({ cfg });

    expect(repaired.cfg.agents?.defaults?.mediaModels).toEqual({
      image: "openai/gpt-5.4",
      video: { primary: "openai/gpt-5.5" },
      music: { fallbacks: ["openai/gpt-5.4", "custom/team/music"] },
    });
    expect(repaired.changes).toEqual(collectConfigModelRefs(cfg));
    expect(repaired.changes).toHaveLength(3);
    expect(rewriteConfigModelRefs({ cfg: repaired.cfg }).changes).toEqual([]);
  });
});
