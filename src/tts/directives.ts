import type { OpenClawConfig } from "../config/config.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { listSpeechProviders } from "./provider-registry.js";
import type {
  SpeechModelOverridePolicy,
  SpeechProviderConfig,
  SpeechProviderOverrides,
  TtsDirectiveOverrides,
  TtsDirectiveParseResult,
} from "./provider-types.js";

type ParseTtsDirectiveOptions = {
  cfg?: OpenClawConfig;
  providers?: readonly SpeechProviderPlugin[];
  providerConfigs?: Record<string, SpeechProviderConfig>;
  openaiBaseUrl?: string;
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
  const explicit = options?.providerConfigs?.[provider.id];
  if (explicit) {
    return explicit;
  }
  if (provider.id === "openai" && options?.openaiBaseUrl) {
    return { baseUrl: options.openaiBaseUrl };
  }
  return undefined;
}

function mergeProviderOverrides(
  target: TtsDirectiveOverrides,
  providerId: string,
  next: SpeechProviderOverrides,
): void {
  target.providerOverrides = {
    ...target.providerOverrides,
    [providerId]: {
      ...target.providerOverrides?.[providerId],
      ...next,
    },
  };
}

function resolveLegacyOptions(
  optionsOrOpenaiBaseUrl?: ParseTtsDirectiveOptions | string,
): ParseTtsDirectiveOptions | undefined {
  if (typeof optionsOrOpenaiBaseUrl === "string") {
    return { openaiBaseUrl: optionsOrOpenaiBaseUrl };
  }
  return optionsOrOpenaiBaseUrl;
}

export function parseTtsDirectives(
  text: string,
  policy: SpeechModelOverridePolicy,
  optionsOrOpenaiBaseUrl?: ParseTtsDirectiveOptions | string,
): TtsDirectiveParseResult {
  if (!policy.enabled) {
    return { cleanedText: text, overrides: {}, warnings: [], hasDirective: false };
  }

  const options = resolveLegacyOptions(optionsOrOpenaiBaseUrl);
  const providers = resolveDirectiveProviders(options);
  const overrides: TtsDirectiveOverrides = {};
  const warnings: string[] = [];
  let cleanedText = text;
  let hasDirective = false;

  const blockRegex = /\[\[tts:text\]\]([\s\S]*?)\[\[\/tts:text\]\]/gi;
  cleanedText = cleanedText.replace(blockRegex, (_match, inner: string) => {
    hasDirective = true;
    if (policy.allowText && overrides.ttsText == null) {
      overrides.ttsText = inner.trim();
    }
    return "";
  });

  const directiveRegex = /\[\[tts:([^\]]+)\]\]/gi;
  cleanedText = cleanedText.replace(directiveRegex, (_match, body: string) => {
    hasDirective = true;
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
          mergeProviderOverrides(overrides, provider.id, parsed.overrides);
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
