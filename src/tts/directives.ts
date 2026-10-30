import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  buildCodeSpanIndex,
  createInlineCodeState,
} from "../../packages/markdown-core/src/code-spans.js";
import type { FenceScanState } from "../../packages/markdown-core/src/fences.js";
import type { OpenClawConfig } from "../config/types.js";
import type { AssistantDeliveryTtsFacts } from "../llm/types.js";
import type { SpeechProviderPlugin } from "../plugins/types.js";
import { extractTtsDirectiveFacts, resolveTtsDirectiveBody } from "./directive-facts.js";
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

// TRANSITIONAL(marker-retirement): the [[tts ...]] text DSL is a transitional
// adapter for automatic-mode replies; structured voiceText/voiceProvider/voiceId
// fields are canonical. Delete the DSL parse forms and this streaming cleaner
// when the visibleReplies default flips to "message_tool".
/** Streaming cleaner used to strip TTS tags before final text parsing is available. */
type TtsDirectiveTextStreamCleaner = {
  push: (text: string) => string;
  flush: () => string;
  hasBufferedDirectiveText: () => boolean;
};

function classifyTtsTag(body: string): "hidden-open" | "hidden-close" | "tts" | "other" {
  const normalized = body.trim().replace(/\s+/g, "").toLowerCase();
  if (normalized === "tts:text") {
    return "hidden-open";
  }
  if (normalized === "/tts:text") {
    return "hidden-close";
  }
  if (
    normalized === "tts" ||
    normalized.startsWith("tts:") ||
    normalized === "/tts" ||
    normalized.startsWith("/tts:")
  ) {
    return "tts";
  }
  return "other";
}

/** Create an incremental cleaner for hiding [[tts:*]] directive text while streaming. */
export function createTtsDirectiveTextStreamCleaner(): TtsDirectiveTextStreamCleaner {
  let pending = "";
  let insideHiddenTextBlock = false;
  let inlineCode = createInlineCodeState();
  let fence: FenceScanState = {};
  // Speech-only Markdown must not change the code ownership of later visible text.
  const trackVisibleText = (
    text: string,
    code = buildCodeSpanIndex(text, inlineCode, fence),
  ): string => {
    inlineCode = code.inlineState;
    fence = code.fenceState;
    return text;
  };

  return {
    push(text: string): string {
      const input = pending + text;
      pending = "";
      let output = "";
      let index = 0;

      while (index < input.length) {
        const tagStart = input.indexOf("[[", index);
        if (tagStart === -1) {
          // A chunk can end on a single "["; hold it so the next chunk can
          // complete "[[" instead of leaking markup or swallowing the rest.
          const tail = input.endsWith("[") ? input.length - 1 : input.length;
          if (!insideHiddenTextBlock) {
            output += trackVisibleText(input.slice(index, tail));
          }
          pending = input.slice(tail);
          break;
        }

        const tagEnd = input.indexOf("]]", tagStart + 2);
        if (tagEnd === -1) {
          // Directive delimiters can cross chunk boundaries; buffer from the
          // opener so a partial tag never leaks to a streamed client.
          if (!insideHiddenTextBlock) {
            output += trackVisibleText(input.slice(index, tagStart));
          }
          pending = input.slice(tagStart);
          break;
        }
        const tag = classifyTtsTag(input.slice(tagStart + 2, tagEnd));
        const keepTag = tag === "other";
        if (!insideHiddenTextBlock) {
          const segment = input.slice(index, tagEnd + 2);
          const code = buildCodeSpanIndex(segment, inlineCode, fence);
          if (code.isInside(tagStart - index)) {
            output += trackVisibleText(segment, code);
            index = tagEnd + 2;
            continue;
          }
          // A tag can be the trailing text that prevents a fence from closing.
          output += trackVisibleText(
            input.slice(index, keepTag ? tagEnd + 2 : tagStart),
            keepTag ? code : undefined,
          );
        }

        if (tag === "hidden-open") {
          insideHiddenTextBlock = true;
        } else if (tag === "hidden-close") {
          insideHiddenTextBlock = false;
        } else if (tag === "tts" && !insideHiddenTextBlock) {
          const body = /^\s*tts\s*:([\s\S]*)$/i.exec(input.slice(tagStart + 2, tagEnd))?.[1];
          if (body !== undefined) {
            output += trackVisibleText(resolveTtsDirectiveBody(body) ?? "");
          }
        }

        index = tagEnd + 2;
      }

      return output;
    },
    flush(): string {
      const tail = insideHiddenTextBlock ? "" : pending;
      pending = "";
      insideHiddenTextBlock = false;
      inlineCode = createInlineCodeState();
      fence = {};
      return tail;
    },
    hasBufferedDirectiveText(): boolean {
      return pending.length > 0 || insideHiddenTextBlock;
    },
  };
}

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
      let handled = false;
      for (const provider of directiveProviders) {
        const genericSpeakerOverrides = ((): SpeechProviderOverrides | undefined => {
          if (!policy.allowVoice) {
            return undefined;
          }
          switch (key) {
            case "speakervoice":
            case "speaker_voice":
              return { speakerVoice: value, voice: value, voiceName: value };
            case "speakervoiceid":
            case "speaker_voice_id":
              return { speakerVoiceId: value, voiceId: value };
            default:
              return undefined;
          }
        })();
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
