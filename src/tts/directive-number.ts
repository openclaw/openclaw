import {
  asFiniteNumberInRange,
  parseStrictFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechProviderOverrides,
} from "./provider-types.js";

/** Parse a numeric speech directive token and return provider overrides when policy allows it. */
export function parseSpeechDirectiveNumberOverride(params: {
  ctx: SpeechDirectiveTokenParseContext;
  overrideKey: string;
  range: Parameters<typeof asFiniteNumberInRange>[1];
  warning: (value: string) => string;
  mergeCurrentOverrides?: boolean;
}): SpeechDirectiveTokenParseResult {
  if (!params.ctx.policy.allowVoiceSettings) {
    return { handled: true };
  }

  const value = parseStrictFiniteNumber(params.ctx.value);
  if (value === undefined || asFiniteNumberInRange(value, params.range) === undefined) {
    return { handled: true, warnings: [params.warning(params.ctx.value)] };
  }

  const nextOverride: SpeechProviderOverrides = { [params.overrideKey]: value };
  return {
    handled: true,
    overrides: params.mergeCurrentOverrides
      ? { ...params.ctx.currentOverrides, ...nextOverride }
      : nextOverride,
  };
}
