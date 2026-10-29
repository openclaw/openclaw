import { parseSpeechDirectiveNumberOverride } from "./directive-number.js";
import type {
  SpeechDirectiveTokenParseContext,
  SpeechDirectiveTokenParseResult,
  SpeechModelOverridePolicy,
} from "./provider-types.js";

type SpeechDirectiveRule = readonly [
  policy: keyof SpeechModelOverridePolicy,
  keys: readonly string[],
  options?: {
    value?: (ctx: SpeechDirectiveTokenParseContext) => unknown;
    number?: Pick<Parameters<typeof parseSpeechDirectiveNumberOverride>[0], "range" | "warning">;
    parse?: (ctx: SpeechDirectiveTokenParseContext) => SpeechDirectiveTokenParseResult;
  },
];

/** Share alias dispatch and policy gating while providers retain their value contracts. */
export function createSpeechDirectiveParser(
  rules: Record<string, SpeechDirectiveRule>,
  options?: {
    formatErrorMessage?: (error: unknown) => string;
  },
): (ctx: SpeechDirectiveTokenParseContext) => SpeechDirectiveTokenParseResult {
  const byKey = new Map(
    Object.entries(rules).flatMap(([overrideKey, [policy, keys, field]]) =>
      keys.map((key) => [key, { overrideKey, policy, ...field }] as const),
    ),
  );
  return (ctx) => {
    const rule = byKey.get(ctx.key);
    if (!rule) {
      return { handled: false };
    }
    if (!ctx.policy[rule.policy]) {
      return { handled: true };
    }
    try {
      return rule.parse
        ? rule.parse(ctx)
        : rule.number
          ? parseSpeechDirectiveNumberOverride({
              ctx,
              overrideKey: rule.overrideKey,
              ...rule.number,
            })
          : {
              handled: true,
              overrides: { [rule.overrideKey]: rule.value ? rule.value(ctx) : ctx.value },
            };
    } catch (error) {
      if (!options?.formatErrorMessage) {
        throw error;
      }
      return { handled: true, warnings: [options.formatErrorMessage(error)] };
    }
  };
}
