import type { OpenClawConfig } from "../config/config.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
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
};

type ParseTtsDirectiveLineState = "normal" | "in_tts_text_block";

type ParsedTtsDirectiveLines = {
  cleanedText: string;
  directiveBodies: string[];
  ttsTextBlocks: string[];
  hasDirective: boolean;
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

function parseStandaloneDirectiveBody(trimmedLine: string): string | undefined {
  const match = /^\[\[tts:([^\]]+)\]\]$/u.exec(trimmedLine);
  if (!match) {
    return undefined;
  }
  const body = match[1]?.trim();
  return body ? body : undefined;
}

function parseTtsDirectiveLines(text: string): ParsedTtsDirectiveLines {
  const newline = text.match(/\r\n|\n|\r/u)?.[0] ?? "\n";
  const lines = text.split(/\r\n|\n|\r/u);
  const cleanedLines: string[] = [];
  const directiveBodies: string[] = [];
  const ttsTextBlocks: string[] = [];
  let state: ParseTtsDirectiveLineState = "normal";
  let pendingTtsStartLine: string | undefined;
  let currentTtsBlockLines: string[] = [];
  let hasDirective = false;

  for (const line of lines) {
    const trimmedLine = line.trim();
    const normalizedLine = trimmedLine.toLowerCase();
    if (state === "normal") {
      if (normalizedLine === "[[tts:text]]") {
        pendingTtsStartLine = line;
        currentTtsBlockLines = [];
        state = "in_tts_text_block";
        continue;
      }

      const directiveBody = parseStandaloneDirectiveBody(trimmedLine);
      if (directiveBody) {
        directiveBodies.push(directiveBody);
        hasDirective = true;
        continue;
      }

      cleanedLines.push(line);
      continue;
    }

    if (normalizedLine === "[[/tts:text]]") {
      ttsTextBlocks.push(currentTtsBlockLines.join(newline));
      pendingTtsStartLine = undefined;
      currentTtsBlockLines = [];
      state = "normal";
      hasDirective = true;
      continue;
    }

    currentTtsBlockLines.push(line);
  }

  if (state === "in_tts_text_block") {
    if (pendingTtsStartLine !== undefined) {
      cleanedLines.push(pendingTtsStartLine);
    }
    cleanedLines.push(...currentTtsBlockLines);
  }

  return {
    cleanedText: cleanedLines.join(newline),
    directiveBodies,
    ttsTextBlocks,
    hasDirective,
  };
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
  const parsedLines = parseTtsDirectiveLines(text);
  const { cleanedText } = parsedLines;
  const hasDirective = parsedLines.hasDirective;

  for (const inner of parsedLines.ttsTextBlocks) {
    if (policy.allowText && overrides.ttsText == null) {
      overrides.ttsText = inner.trim();
    }
  }

  for (const body of parsedLines.directiveBodies) {
    const tokens = body.split(/\s+/).filter(Boolean);
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
      const key = rawKey.toLowerCase();
      if (key === "provider") {
        if (policy.allowProvider) {
          const providerId = rawValue.trim().toLowerCase();
          if (providerId) {
            overrides.provider = providerId;
          } else {
            warnings.push("invalid provider id");
          }
        }
        continue;
      }

      let handled = false;
      for (const provider of providers) {
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
        handled = true;
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

      if (!handled) {
        continue;
      }
    }
  }

  return {
    cleanedText,
    ttsText: overrides.ttsText,
    hasDirective,
    overrides,
    warnings,
  };
}
