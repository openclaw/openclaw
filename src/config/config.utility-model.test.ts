import { expect, it } from "vitest";
import { shouldSuppressMissingCodexPluginDiagnostics } from "./codex-plugin-diagnostics.js";
import { normalizeSubmittedConfigModelRefs } from "./model-input-normalization.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { OpenClawSchema } from "./zod-schema.js";

const anthropic = "anthropic/claude-sonnet-4-6";
const codex = "openai/gpt-5.3-codex-spark";

it.each([
  { utilityModel: { primary: anthropic, fallbacks: [codex] }, override: undefined, warns: true },
  { utilityModel: { primary: codex }, override: { fallbacks: [] }, warns: true },
  { utilityModel: { fallbacks: [codex] }, override: anthropic, warns: false },
  { utilityModel: { fallbacks: [codex] }, override: { fallbacks: [] }, warns: false },
  { utilityModel: codex, override: "", warns: false },
])("diagnoses effective utility routes for Codex: %j", ({ utilityModel, override, warns }) => {
  const agents: OpenClawConfig["agents"] = {
    defaults: { model: { primary: anthropic, fallbacks: [] }, utilityModel },
    entries: { openclaw: { utilityModel: override } },
  };

  expect(shouldSuppressMissingCodexPluginDiagnostics({ agents }, {})).toBe(!warns);
});

it("accepts string and primary/fallback forms without changing their authored shape", () => {
  const agents = {
    ownership: "explicit",
    defaults: {
      utilityModel: { primary: "helper", fallbacks: ["local/backup", "remote/small"] },
    },
    entries: {
      inherited: {},
      shorthand: { utilityModel: "local/small" },
      disabled: { utilityModel: "" },
      primaryOnly: { utilityModel: { primary: "other" } },
      fallbackOnly: { utilityModel: { fallbacks: [] } },
    },
  };

  expect(OpenClawSchema.parse({ agents }).agents).toEqual(agents);
});

it.each([{ fallbacks: "local/backup" }, { fallbacks: [false] }, { timeoutMs: 1000 }])(
  "rejects malformed or unsupported utility model fields: %j",
  (utilityModel) => {
    for (const agents of [
      { defaults: { utilityModel }, entries: { worker: {} } },
      { entries: { worker: { utilityModel } } },
    ]) {
      expect(OpenClawSchema.safeParse({ agents }).success).toBe(false);
    }
  },
);

it("normalizes utility primary and fallback refs through the shared config writer policy", () => {
  const agents: OpenClawConfig["agents"] = {
    defaults: {
      utilityModel: { primary: " helper ", fallbacks: [" google/gemini-3-pro-preview "] },
    },
    entries: {
      worker: { utilityModel: { fallbacks: [" together/moonshotai/Kimi-K2.5 "] } },
      disabled: { utilityModel: "" },
    },
  };

  expect(normalizeSubmittedConfigModelRefs({ agents }).agents).toEqual({
    defaults: {
      utilityModel: { primary: "helper", fallbacks: ["google/gemini-3.1-pro-preview"] },
    },
    entries: {
      worker: { utilityModel: { fallbacks: ["together/moonshotai/Kimi-K2.6"] } },
      disabled: { utilityModel: "" },
    },
  });
});
