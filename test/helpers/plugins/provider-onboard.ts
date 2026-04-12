import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "openclaw/plugin-sdk/provider-onboard";
import { expect } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { createConfigWithFallbacks, EXPECTED_FALLBACKS } from "./onboard-config.js";

export function expectProviderOnboardAllowlistAlias(params: {
  applyProviderConfig: (config: OpenClawConfig) => OpenClawConfig;
  modelRef: string;
  alias: string;
}) {
  const withDefault = params.applyProviderConfig({});
  expect(Object.keys(withDefault.agents?.defaults?.models ?? {})).toContain(params.modelRef);

  const withAlias = params.applyProviderConfig({
    agents: {
      defaults: {
        models: {
          [params.modelRef]: { alias: params.alias },
        },
      },
    },
  });
  expect(withAlias.agents?.defaults?.models?.[params.modelRef]?.alias).toBe(params.alias);
}

export function expectProviderOnboardPrimaryAndFallbacks(params: {
  applyConfig: (config: OpenClawConfig) => OpenClawConfig;
  modelRef: string;
}) {
  const cfg = params.applyConfig({});
  expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(params.modelRef);

  const cfgWithFallbacks = params.applyConfig(createConfigWithFallbacks());
  expect(resolveAgentModelFallbackValues(cfgWithFallbacks.agents?.defaults?.model)).toEqual([
    ...EXPECTED_FALLBACKS,
  ]);
}
