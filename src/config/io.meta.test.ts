import { describe, expect, it } from "vitest";
import { stampConfigWriteMetadata } from "./io.meta.js";
import { computeModelPolicyAllowlist } from "./model-policy-allowlist-migration.js";
import type { AgentModelEntryConfig, AgentModelPolicyConfig } from "./types.agent-defaults.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { validateConfigObjectRaw } from "./validation-core.js";

const models = { "openai/gpt-5.5": {} };
const marker = { migrations: { modelPolicyAllowlist: true as const } };
const withModels = (
  entries: Record<string, AgentModelEntryConfig>,
  modelPolicy?: AgentModelPolicyConfig,
): OpenClawConfig => ({
  agents: {
    defaults: { models: entries, ...(modelPolicy ? { modelPolicy } : {}) },
    entries: { main: {} },
  },
});
const legacy = withModels(models);
const restricted = withModels(models, { allow: Object.keys(models) });
const perAgent: OpenClawConfig = {
  agents: {
    defaults: legacy.agents?.defaults,
    list: [{ id: "worker", models: { "anthropic/claude-sonnet-4-6": {} } }],
  },
};

describe("config write metadata stamping", () => {
  const cases: Array<
    [string, OpenClawConfig | null, OpenClawConfig, AgentModelPolicyConfig | undefined]
  > = [
    ["retains restrictions after removing metadata", legacy, {}, { allow: Object.keys(models) }],
    ["materializes only default restrictions", perAgent, perAgent, { allow: Object.keys(models) }],
    [
      "does not trust candidate markers",
      withModels({ "demo/previous": {} }),
      { ...legacy, meta: marker },
      { allow: ["demo/previous"] },
    ],
    ["leaves new maps unrestricted", null, legacy, undefined],
    [
      "does not restore removed marked policies",
      { ...restricted, meta: marker },
      legacy,
      undefined,
    ],
    ["does not restore removed pre-marker policies", restricted, legacy, undefined],
    ["honors explicit allow-any", legacy, withModels(models, {}), {}],
  ];
  it.each(cases)("%s", (_name, previous, next, policy) => {
    const original = structuredClone({ previous, next });
    const stamped = stampConfigWriteMetadata(next, "2026.7.2", previous);
    expect(stamped.agents?.defaults?.modelPolicy).toEqual(policy);
    expect(stamped.agents?.list).toEqual(next.agents?.list);
    expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBe(true);
    expect(stamped.meta?.lastTouchedVersion).toBe("2026.7.2");
    expect({ previous, next }).toEqual(original);
  });

  it("preserves a restriction containing wildcard, alias and selector refs", () => {
    const modelMap = {
      "openai/*": {},
      approved: {},
      "demo/model": { alias: "approved" },
      "demo/namespace/*": {},
      "openrouter:auto": {},
      "openrouter:free": {},
    };
    const previous = withModels(modelMap);
    const stamped = stampConfigWriteMetadata(previous, undefined, previous);
    expect(stamped.agents?.defaults?.modelPolicy?.allow).toEqual(Object.keys(modelMap));
    expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBe(true);
    expect(validateConfigObjectRaw(stamped)).toEqual({ ok: true, config: expect.anything() });
  });

  it.each([false, true])(
    "defers unresolved restrictions despite candidate marker %s",
    (candidateMarker) => {
      const previous = withModels({ bare: {} });
      const next = { ...previous, ...(candidateMarker ? { meta: marker } : {}) };
      const stamped = stampConfigWriteMetadata(next, undefined, previous);
      expect(stamped.agents).toEqual(next.agents);
      expect(stamped.meta?.migrations?.modelPolicyAllowlist).toBeUndefined();
      expect(validateConfigObjectRaw(stamped)).toEqual({ ok: true, config: expect.anything() });
      expect(
        computeModelPolicyAllowlist({ root: stamped, defaults: stamped.agents?.defaults }),
      ).toEqual(["bare"]);
    },
  );
});
