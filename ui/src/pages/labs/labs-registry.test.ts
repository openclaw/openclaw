import { expect, it } from "vitest";
import { resolveLabFeatureState } from "./labs-feature-state.ts";
import { LAB_FEATURES, labFeatureMergePatch, labFeatureResetPatch } from "./labs-registry.ts";

it("keeps usage ranking off by default and resets only its Boolean override", () => {
  const feature = LAB_FEATURES.find((entry) => entry.id === "usageRankedToolIndex")!;
  expect(resolveLabFeatureState({}, feature)).toEqual({
    enabled: false,
    defaultEnabled: false,
    overridden: false,
  });
  const config = {
    agents: {
      defaults: { experimental: { decisionAssistance: true, usageRankedToolIndex: true } },
    },
  };
  expect(resolveLabFeatureState(config, feature)).toEqual({
    enabled: true,
    defaultEnabled: false,
    overridden: true,
  });
  expect(labFeatureMergePatch(feature, false)).toEqual({
    agents: { defaults: { experimental: { usageRankedToolIndex: false } } },
  });
  expect(labFeatureResetPatch(config, feature)).toEqual({
    agents: { defaults: { experimental: { usageRankedToolIndex: null } } },
  });
});
