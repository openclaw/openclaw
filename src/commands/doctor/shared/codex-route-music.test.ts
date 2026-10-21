import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { rewriteConfigModelRefs } from "./codex-route-config-repair.js";
import { collectConfigModelRefs } from "./codex-route-config-scan.js";

type AgentDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
const musicPath = "agents.defaults.mediaModels.music";
const authoredFallbacks = ["custom/team/song@authored:backup", "openai/codex/team/music"];

function modelConfig(
  mediaModels: AgentDefaults["mediaModels"],
  models?: AgentDefaults["models"],
): OpenClawConfig {
  return {
    plugins: { enabled: false },
    agents: {
      defaults: { model: "openai/current-model", mediaModels, ...(models ? { models } : {}) },
    },
  };
}

describe("Codex music model migration", () => {
  it.each(["codex", "openai-codex"])("repairs a scalar %s music reference", (provider) => {
    const cfg = modelConfig({ music: `${provider}/gpt-5.4` });
    const before = structuredClone(cfg);

    const detected = collectConfigModelRefs(cfg);
    const repaired = rewriteConfigModelRefs({ cfg });

    expect(detected).toEqual([
      { path: musicPath, model: `${provider}/gpt-5.4`, canonicalModel: "openai/gpt-5.4" },
    ]);
    expect(repaired.changes).toEqual(detected);
    expect(repaired.cfg.agents?.defaults?.mediaModels?.music).toBe("openai/gpt-5.4");
    expect(collectConfigModelRefs(repaired.cfg)).toEqual([]);
    expect(rewriteConfigModelRefs({ cfg: repaired.cfg }).cfg).toBe(repaired.cfg);
    expect(cfg).toEqual(before);
  });

  it("preserves fallback order, suffixes and explicit canonical settings", () => {
    const cfg = modelConfig(
      {
        music: {
          primary: "openai-codex/gpt-5.4@authored:music",
          fallbacks: ["codex/gpt-5.5", ...authoredFallbacks],
        },
      },
      {
        "openai/gpt-5.4@authored:music": {
          alias: "Authored music choice",
          agentRuntime: { id: "openclaw" },
        },
      },
    );

    const repaired = rewriteConfigModelRefs({ cfg });

    expect(repaired.cfg.agents?.defaults?.mediaModels?.music).toEqual({
      primary: "openai/gpt-5.4@authored:music",
      fallbacks: ["openai/gpt-5.5", ...authoredFallbacks],
    });
    expect(repaired.cfg.agents?.defaults?.models).toEqual(cfg.agents?.defaults?.models);
    expect(repaired.changes).toEqual(collectConfigModelRefs(cfg));
    expect(repaired.changes.map((hit) => hit.path)).toEqual([
      `${musicPath}.primary`,
      `${musicPath}.fallbacks.0`,
    ]);
    expect(rewriteConfigModelRefs({ cfg: repaired.cfg }).changes).toEqual([]);
  });

  it.each(["openai-codex\0", "openai-codex\0gpt-5.4"])(
    "preserves a blocked music selection while repairing an unblocked fallback (%j)",
    (blockedIdentity) => {
      const cfg = modelConfig({
        music: {
          primary: "openai-codex/gpt-5.4@authored:music",
          fallbacks: ["codex/gpt-5.5", "custom/team/music"],
        },
      });
      const blockedModelIdentities = new Set([blockedIdentity]);

      const repaired = rewriteConfigModelRefs({ cfg, blockedModelIdentities });

      expect(repaired.cfg.agents?.defaults?.mediaModels?.music).toEqual({
        primary: "openai-codex/gpt-5.4@authored:music",
        fallbacks: ["openai/gpt-5.5", "custom/team/music"],
      });
      expect(repaired.changes).toEqual(collectConfigModelRefs(cfg, blockedModelIdentities));
      expect(repaired.changes.map((hit) => hit.path)).toEqual([`${musicPath}.fallbacks.0`]);
      expect(collectConfigModelRefs(repaired.cfg, blockedModelIdentities)).toEqual([]);
    },
  );

  it("keeps music detection and writing aligned with image and video", () => {
    const cfg = modelConfig({
      image: "openai-codex/gpt-5.4",
      video: { primary: "codex/gpt-5.5" },
      music: { fallbacks: ["openai-codex/gpt-5.4", "custom/team/music"] },
    });

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
