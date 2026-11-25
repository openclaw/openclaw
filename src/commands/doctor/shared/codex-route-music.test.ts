import { expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { rewriteConfigModelRefs } from "./codex-route-config-repair.js";
import { collectConfigModelRefs } from "./codex-route-config-scan.js";

type Defaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
const musicPath = "agents.defaults.mediaModels.music";
const authoredFallbacks = ["custom/team/song@authored:backup", "openai/codex/team/music"];
const legacyMusic = {
  primary: "openai-codex/gpt-5.4@authored:music",
  fallbacks: ["codex/gpt-5.5", ...authoredFallbacks],
};
const canonicalMusic = {
  primary: "openai/gpt-5.4@authored:music",
  fallbacks: ["openai/gpt-5.5", ...authoredFallbacks],
};
function config(mediaModels: Defaults["mediaModels"], models?: Defaults["models"]): OpenClawConfig {
  return {
    plugins: { enabled: false },
    agents: { defaults: { model: "openai/current-model", mediaModels, models } },
  };
}
function repair(cfg: OpenClawConfig, blockedModelIdentities?: ReadonlySet<string>) {
  const result = rewriteConfigModelRefs({ cfg, blockedModelIdentities });
  expect(result.changes).toEqual(collectConfigModelRefs(cfg, blockedModelIdentities));
  expect(collectConfigModelRefs(result.cfg, blockedModelIdentities)).toEqual([]);
  expect(rewriteConfigModelRefs({ cfg: result.cfg, blockedModelIdentities }).cfg).toBe(result.cfg);
  return result;
}

it.each(["codex", "openai-codex"])("repairs a scalar %s music reference", (provider) => {
  const cfg = config({ music: `${provider}/gpt-5.4` });
  const before = structuredClone(cfg);
  const result = repair(cfg);
  expect(result.cfg.agents?.defaults?.mediaModels?.music).toBe("openai/gpt-5.4");
  expect(result.changes).toEqual([
    { path: musicPath, model: `${provider}/gpt-5.4`, canonicalModel: "openai/gpt-5.4" },
  ]);
  expect(cfg).toEqual(before);
});

it("preserves fallback order, suffixes and explicit canonical settings", () => {
  const models = {
    [canonicalMusic.primary]: { alias: "Authored music choice", agentRuntime: { id: "openclaw" } },
  };
  const cfg = config({ music: legacyMusic }, models);
  const result = repair(cfg);
  expect(result.cfg.agents?.defaults?.mediaModels?.music).toEqual(canonicalMusic);
  expect(result.cfg.agents?.defaults?.models).toEqual(models);
  expect(result.changes.map((hit) => hit.path)).toEqual([
    `${musicPath}.primary`,
    `${musicPath}.fallbacks.0`,
  ]);
});

it.each(["openai-codex\0", "openai-codex\0gpt-5.4"])(
  "keeps blocked music but repairs its fallback (%j)",
  (blockedIdentity) => {
    const result = repair(config({ music: legacyMusic }), new Set([blockedIdentity]));
    expect(result.cfg.agents?.defaults?.mediaModels?.music).toEqual({
      ...canonicalMusic,
      primary: legacyMusic.primary,
    });
    expect(result.changes.map((hit) => hit.path)).toEqual([`${musicPath}.fallbacks.0`]);
  },
);

it("keeps music detection and writing aligned with image and video", () => {
  const result = repair(
    config({
      image: "openai-codex/gpt-5.4",
      video: { primary: "codex/gpt-5.5" },
      music: { fallbacks: ["openai-codex/gpt-5.4", "custom/team/music"] },
    }),
  );
  expect(result.cfg.agents?.defaults?.mediaModels).toEqual({
    image: "openai/gpt-5.4",
    video: { primary: "openai/gpt-5.5" },
    music: { fallbacks: ["openai/gpt-5.4", "custom/team/music"] },
  });
  expect(result.changes).toHaveLength(3);
});
