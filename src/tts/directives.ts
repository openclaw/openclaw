import type { OpenClawConfig } from "../config/types.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { findCodeRegions, isInsideCode } from "../shared/text/code-regions.js";
import { listSpeechProviders } from "./provider-registry.js";
import type {
  SpeechModelOverridePolicy,
  SpeechProviderConfig,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
} from "./provider-types.js";

type ParseTtsDirectiveOptions = {
  cfg?: OpenClawConfig;
  providers?: readonly SpeechProviderPlugin[];
  providerConfigs?: Record<string, SpeechProviderConfig>;
  preferredProviderId?: string;
};

function buildProviderOrder(left: SpeechProviderPlugin, right: SpeechProviderPlugin): number {
  const leftOrder = left.autoSelectOrder ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = right.autoSelectOrder ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.id.localeCompare(right.id);
}

function resolveDirectiveProviders(options?: ParseTtsDirectiveOptions): SpeechProviderPlugin[] {
  if (options?.providers) {
    return [...options.providers].toSorted(buildProviderOrder);
  }
  return listSpeechProviders(options?.cfg).toSorted(buildProviderOrder);
}

function resolveDirectiveProviderConfig(
  provider: SpeechProviderPlugin,
  options?: ParseTtsDirectiveOptions,
): SpeechProviderConfig | undefined {
  return options?.providerConfigs?.[provider.id];
}

function prioritizeProvider(
  providers: readonly SpeechProviderPlugin[],
  providerId: string | undefined,
): SpeechProviderPlugin[] {
  if (!providerId) {
    return [...providers];
  }
  const preferredProvider = providers.find((provider) => provider.id === providerId);
  if (!preferredProvider) {
    return [...providers];
  }
  return [preferredProvider, ...providers.filter((provider) => provider.id !== providerId)];
}

function replaceOutsideCodeRegions(
  text: string,
  regex: RegExp,
  replacer: (match: RegExpMatchArray) => string,
  shouldPreserveMatch: (
    match: RegExpMatchArray,
    start: number,
    codeRegions: { start: number; end: number }[],
  ) => boolean = (_match, start, codeRegions) => isInsideCode(start, codeRegions),
): string {
  regex.lastIndex = 0;
  const codeRegions = findCodeRegions(text);
  let out = "";
  let cursor = 0;

  for (const match of text.matchAll(regex)) {
    const start = match.index ?? 0;
    out += text.slice(cursor, start);
    if (shouldPreserveMatch(match, start, codeRegions)) {
      out += match[0];
    } else {
      out += replacer(match);
    }
    cursor = start + match[0].length;
  }

  out += text.slice(cursor);
  return out;
}

export function parseTtsDirectives(
  text: string,
  policy: SpeechModelOverridePolicy,
  options?: ParseTtsDirectiveOptions,
): TtsDirectiveParseResult {
  if (!policy.enabled) {
    return { cleanedText: text, overrides: {}, warnings: [], hasDirective: false };
  }

  const providers = resolveDirectiveProviders(options);
  const overrides: TtsDirectiveOverrides = {};
  const warnings: string[] = [];
  let cleanedText = text;
  let hasDirective = false;

  const blockRegex = /\[\[tts:text\]\]([\s\S]*?)\[\[\/tts:text\]\]/gi;
  const ttsTextOpenTagLength = "[[tts:text]]".length;
  const ttsTextCloseTagLength = "[[/tts:text]]".length;
  cleanedText = replaceOutsideCodeRegions(
    cleanedText,
    blockRegex,
    (match) => {
      const inner = match[1] ?? "";
      hasDirective = true;
      if (policy.allowText && overrides.ttsText == null) {
        overrides.ttsText = inner.trim();
      }
      return "";
    },
    (match, start, codeRegions) => {
      const end = start + match[0].length;
      const closingTagStart = end - ttsTextCloseTagLength;
      return (
        isInsideCode(start, codeRegions) ||
        isInsideCode(start + ttsTextOpenTagLength - 1, codeRegions) ||
        isInsideCode(closingTagStart, codeRegions) ||
        isInsideCode(closingTagStart + ttsTextCloseTagLength - 1, codeRegions)
      );
    },
  );

  const directiveRegex = /\[\[tts:([^\]]+)\]\]/gi;
  cleanedText = replaceOutsideCodeRegions(cleanedText, directiveRegex, (match) => {
    const body = match[1] ?? "";
    hasDirective = true;
    const tokens = body.split(/\s+/).filter(Boolean);

    let declaredProviderId: string | undefined;
    if (policy.allowProvider) {
      for (const token of tokens) {
        const eqIndex = token.indexOf("=");
        if (eqIndex === -1) {
          continue;
        }
        const rawKey = token.slice(0, eqIndex).trim();
        if (!rawKey || normalizeLowercaseStringOrEmpty(rawKey) !== "provider") {
          continue;
        }
        const rawValue = token.slice(eqIndex + 1).trim();
        if (!rawValue) {
          continue;
        }
        const providerId = normalizeLowercaseStringOrEmpty(rawValue);
        if (!providerId) {
          warnings.push("invalid provider id");
          continue;
        }
        declaredProviderId = providerId;
        overrides.provider = providerId;
      }
    }

    const orderedProviders = prioritizeProvider(
      providers,
      declaredProviderId ?? normalizeLowercaseStringOrEmpty(options?.preferredProviderId),
    );

    for (const token of tokens) {
      const eqIndex = token.indexOf("=");
      if (eqIndex === -1) {
        continue;
      }
      const rawKey = token.slice(0, eqIndex).trim();
      const rawValue = token.slice(eqIndex + 1).trim();
      if (!rawKey || !rawValue) {
        continue;
      }
      const key = normalizeLowercaseStringOrEmpty(rawKey);
      if (key === "provider") {
        continue;
      }

      for (const provider of orderedProviders) {
        const parsed = provider.parseDirectiveToken?.({
          key,
          value: rawValue,
          policy,
          providerConfig: resolveDirectiveProviderConfig(provider, options),
          currentOverrides: overrides.providerOverrides?.[provider.id],
        });
        if (!parsed?.handled) {
          continue;
        }
        if (parsed.overrides) {
          overrides.providerOverrides = {
            ...overrides.providerOverrides,
            [provider.id]: {
              ...overrides.providerOverrides?.[provider.id],
              ...parsed.overrides,
            },
          };
        }
        if (parsed.warnings?.length) {
          warnings.push(...parsed.warnings);
        }
        break;
      }
    }
    return "";
  });

  return {
    cleanedText,
    ttsText: overrides.ttsText,
    hasDirective,
    overrides,
    warnings,
  };
}
