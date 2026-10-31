import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.js";
import type { AssistantDeliveryTtsFacts } from "../llm/types.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { extractTtsDirectiveFacts } from "./directive-facts.js";
import { compareSpeechProviderOrder } from "./provider-registry-core.js";
import { listSpeechProviders } from "./provider-registry.js";
import type {
  SpeechDirectiveTokenParseResult,
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
  preferredProviderId?: string;
};

/** Resolve persisted TTS facts against the active model/provider policy. */
export function resolveTtsDirectiveFacts(
  facts: AssistantDeliveryTtsFacts | undefined,
  policy: SpeechModelOverridePolicy,
  options?: ParseTtsDirectiveOptions,
): Omit<TtsDirectiveParseResult, "cleanedText"> {
  if (!facts || !policy.enabled) {
    return { overrides: {}, warnings: [], hasDirective: false };
  }

  let providers: SpeechProviderPlugin[] | undefined;
  const overrides: TtsDirectiveOverrides = {};
  const warnings: string[] = [];
  if (policy.allowText && facts.text != null) {
    overrides.ttsText = facts.text;
  }

  for (const directive of facts.directives ?? []) {
    const declaredProviderId = policy.allowProvider ? directive.provider : undefined;
    if (declaredProviderId) {
      overrides.provider = declaredProviderId;
    }
    const values = Object.entries(directive.values);
    if (values.length === 0) {
      continue;
    }
    providers ??= (options?.providers ?? listSpeechProviders(options?.cfg)).toSorted(
      compareSpeechProviderOrder,
    );
    const normalizedProviderId = normalizeLowercaseStringOrEmpty(
      declaredProviderId || normalizeLowercaseStringOrEmpty(options?.preferredProviderId),
    );
    const selectedProvider = normalizedProviderId
      ? providers.find(
          (provider) =>
            provider.id === normalizedProviderId ||
            provider.aliases?.some(
              (alias) => normalizeLowercaseStringOrEmpty(alias) === normalizedProviderId,
            ),
        )
      : undefined;
    if (declaredProviderId && !selectedProvider) {
      warnings.push(`unknown provider "${declaredProviderId}"`);
      continue;
    }
    const directiveProviders = selectedProvider
      ? [
          selectedProvider,
          ...(declaredProviderId
            ? []
            : providers.filter((provider) => provider.id !== selectedProvider.id)),
        ]
      : providers;

    for (const [key, value] of values) {
      const genericSpeakerOverrides: SpeechProviderOverrides | undefined = !policy.allowVoice
        ? undefined
        : key === "speakervoice" || key === "speaker_voice"
          ? { speakerVoice: value, voice: value, voiceName: value }
          : key === "speakervoiceid" || key === "speaker_voice_id"
            ? { speakerVoiceId: value, voiceId: value }
            : undefined;
      let handled = false;
      for (const provider of directiveProviders) {
        const parsed: SpeechDirectiveTokenParseResult | undefined = genericSpeakerOverrides
          ? { handled: true, overrides: genericSpeakerOverrides }
          : provider.parseDirectiveToken?.({
              key,
              value,
              policy,
              selectedProvider: declaredProviderId ? provider.id : undefined,
              providerConfig: options?.providerConfigs?.[provider.id],
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
        handled = true;
        break;
      }
      if (!handled && declaredProviderId && directiveProviders.length > 0) {
        warnings.push(`unsupported ${declaredProviderId} directive key "${key}"`);
      }
    }
  }

  return {
    ttsText: overrides.ttsText,
    hasDirective: true,
    overrides,
    warnings,
  };
}

/** Parse TTS directives from final message text, leaving markdown code spans unchanged. */
export function parseTtsDirectives(
  text: string,
  policy: SpeechModelOverridePolicy,
  options?: ParseTtsDirectiveOptions,
): TtsDirectiveParseResult {
  if (!policy.enabled) {
    return { cleanedText: text, overrides: {}, warnings: [], hasDirective: false };
  }
  const extracted = extractTtsDirectiveFacts(text);
  const resolved = resolveTtsDirectiveFacts(extracted.facts, policy, options);

  return {
    cleanedText: extracted.cleanedText,
    ...resolved,
  };
}
