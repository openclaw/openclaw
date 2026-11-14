import { expect, it } from "vitest";
import { validateConfigObjectRaw } from "../config/validation-core.js";
import { buildCatalogModel } from "./provider-catalog.test-support.js";
import {
  applyOpencodeZenModelDefault,
  applyAgentDefaultMediaModel,
  applyProviderConfigWithDefaultModels,
  createAliasOnlyPresetAppliers,
  OPENCODE_ZEN_DEFAULT_MODEL,
  type OpenClawConfig,
} from "./provider-onboard.js";

function withDefaults(defaults: NonNullable<OpenClawConfig["agents"]>["defaults"]): OpenClawConfig {
  return { agents: { defaults } };
}

it("applyAgentDefaultMediaModel preserves selected media defaults and the original config on no-op", () => {
  const cfg = withDefaults({ mediaModels: { image: { primary: "operator/image" } } });
  expect(applyAgentDefaultMediaModel(cfg, "image", "provider/image")).toBe(cfg);
  const next = applyAgentDefaultMediaModel(cfg, "video", "provider/video");
  expect(next.agents?.defaults?.mediaModels).toEqual({
    image: { primary: "operator/image" },
    video: { primary: "provider/video" },
  });
  expect(cfg.agents?.defaults?.mediaModels).toEqual({ image: { primary: "operator/image" } });
});
const modelRef = "example/default";
const appliers = createAliasOnlyPresetAppliers({ modelRef, alias: "Example" });

it("adds only the alias entry in provider-only mode", () => {
  const other = { "other/model": { alias: "Other" } };
  const cfg = {
    ...withDefaults({ models: structuredClone(other) }),
    models: { mode: "merge" as const, providers: {} },
  };
  const result = appliers.applyProviderConfig(cfg);
  expect(result.models).toBe(cfg.models);
  expect(result.agents?.defaults?.model).toBeUndefined();
  expect(result.agents?.defaults?.models).toEqual({
    ...other,
    [modelRef]: { alias: "Example" },
  });
});

it("preserves entry fields and alias while replacing the primary", () => {
  const entry = { alias: "Custom", params: { temperature: 0.2 } };
  const cfg = withDefaults({
    model: { primary: "old/model", fallbacks: ["fallback/model"] },
    models: { [modelRef]: structuredClone(entry) },
  });

  const result = appliers.applyConfig(cfg);

  expect(result.agents?.defaults?.model).toEqual({
    primary: modelRef,
    fallbacks: ["fallback/model"],
  });
  expect(result.agents?.defaults?.models?.[modelRef]).toEqual(entry);
});
it("applyOpencodeZenModelDefault no-ops when already the legacy default", () => {
  const cfg = withDefaults({ model: "opencode-zen/claude-opus-4-5" });
  expect(applyOpencodeZenModelDefault(cfg)).toEqual({ changed: false, next: cfg });
});

it("preserves fallbacks when setting primary", () => {
  const cfg = withDefaults({
    model: { primary: "anthropic/claude-opus-4-6", fallbacks: ["google/gemini-3-pro"] },
  });
  const applied = applyOpencodeZenModelDefault(cfg);
  expect(applied.changed).toBe(true);
  expect(applied.next.agents?.defaults?.model).toEqual({
    primary: OPENCODE_ZEN_DEFAULT_MODEL,
    fallbacks: ["google/gemini-3.1-pro-preview"],
  });
});

it("writes catalog model rows to config without their catalog family", () => {
  const row = buildCatalogModel("family-model", { name: "Family model", family: "moonshot" });
  const written = applyProviderConfigWithDefaultModels(
    { models: { mode: "replace" } },
    {
      agentModels: {},
      providerId: "family-host",
      api: "openai-completions",
      baseUrl: "https://family.example/v1",
      defaultModels: [row],
    },
  );
  const { family: _family, ...authored } = row;
  expect(written.models?.providers?.["family-host"]?.models).toEqual([authored]);
  // Strict config validation rejects the catalog-only field the onboarding write omits.
  const models = structuredClone(written.models);
  expect(validateConfigObjectRaw({ models }).ok).toBe(true);
  models!.providers!["family-host"]!.models[0]!.family = "moonshot";
  expect(validateConfigObjectRaw({ models }).ok).toBe(false);
});
