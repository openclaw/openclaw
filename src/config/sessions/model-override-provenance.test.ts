import { expect, it } from "vitest";
import {
  hasSessionActiveAutoModelFallback,
  hasSessionAutoModelSelection,
  hasUserPinnedModelSelection,
  resolveSessionModelOverrideSource,
} from "./model-override-provenance.js";

const pin = { providerOverride: "openai", modelOverride: "gpt-5.6-sol" };
const selection = { providerOverride: "fallback", modelOverride: "secondary" };
const origin = {
  modelOverrideFallbackOriginProvider: "primary",
  modelOverrideFallbackOriginModel: "main",
};
const fallback = { ...selection, ...origin };

it.each([
  ["legacy user override", pin, true],
  ["legacy fallback provenance", fallback, false],
  [
    "explicit default with stale override fields",
    { ...pin, modelOverrideSource: "default" },
    false,
  ],
] as const)("hasUserPinnedModelSelection classifies %s", (_, entry, expected) => {
  expect(hasUserPinnedModelSelection(entry)).toBe(expected);
});

it("preserves truthy status classification before resolver normalization", () => {
  const entry = { modelOverride: "  ", modelOverrideSource: "user" as const };
  expect(hasUserPinnedModelSelection(entry)).toBe(true);
  expect(resolveSessionModelOverrideSource(entry)).toBeNull();
});

it.each([
  ["inherited selection", undefined, null],
  ["explicit user pin", { modelOverride: pin.modelOverride, modelOverrideSource: "user" }, "user"],
  ["automatic fallback", { modelOverride: "fallback", modelOverrideSource: "auto" }, "auto"],
  [
    "explicit default with stale override fields",
    { modelOverride: pin.modelOverride, modelOverrideSource: "default" },
    null,
  ],
  ["legacy user pin", pin, "user"],
  ["legacy automatic fallback", fallback, "auto"],
] as const)("resolveSessionModelOverrideSource classifies %s", (_, entry, expected) => {
  expect(resolveSessionModelOverrideSource(entry)).toBe(expected);
});

it.each([
  [
    "configured automatic selection without fallback provenance",
    { ...selection, modelOverrideSource: "auto" },
    false,
    false,
  ],
  ["different automatic selection", { ...fallback, modelOverrideSource: "auto" }, true, true],
  ["legacy fallback provenance", fallback, true, true],
  [
    "self-origin configured selection",
    {
      ...origin,
      providerOverride: "primary",
      modelOverride: "main",
      modelOverrideSource: "auto",
    },
    true,
    false,
  ],
  [
    "user selection with stale provenance",
    { ...fallback, modelOverrideSource: "user" },
    false,
    false,
  ],
] as const)(
  "hasSessionActiveAutoModelFallback classifies %s",
  (_, entry, automaticSelection, expected) => {
    expect(hasSessionActiveAutoModelFallback(entry)).toBe(expected);
    expect(hasSessionAutoModelSelection(entry)).toBe(automaticSelection);
  },
);
