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

// U+FDD0 is a Unicode non-character reserved for internal use and unlikely to
// appear in user-supplied text, making it a practical sentinel for placeholders.
const PLACEHOLDER_SENTINEL = "\uFDD0";

// CommonMark fenced code block (backticks): line-anchored, 0–3 spaces indent,
// closing fence must be at least as long as the opener, backtick info strings
// reject backticks per spec, unclosed fences extend to EOF.
const BACKTICK_FENCE =
  "(?<=^|\\n) {0,3}(?<btick>`{3,})[^\\n`]*\\r?\\n[\\s\\S]*?(?:\\r?\\n {0,3}\\k<btick>`*[ \\t]*(?=\\r?\\n|$)|$)";

// CommonMark fenced code block (tildes): same structure, tildes allow any info string.
const TILDE_FENCE =
  "(?<=^|\\n) {0,3}(?<tilde>~{3,})[^\\n]*\\r?\\n[\\s\\S]*?(?:\\r?\\n {0,3}\\k<tilde>~*[ \\t]*(?=\\r?\\n|$)|$)";

// Inline code span: named backreference matches any delimiter length (`, ``, ```, …).
// Allows single newlines (CommonMark treats them as spaces in code spans) but
// stops at paragraph breaks (\n\n) to prevent over-masking across blocks.
// Negative lookaround enforces maximal backtick runs per CommonMark §6.1.
const INLINE_CODE = "(?<!`)(?<code>`+)(?!`)(?:[^\\n]|\\n(?!\\n))*?(?<!`)\\k<code>(?!`)";

const CODE_BLOCK_PATTERN = new RegExp(`${BACKTICK_FENCE}|${TILDE_FENCE}|${INLINE_CODE}`, "g");

/**
 * Temporarily replace fenced code blocks and inline code spans with inert
 * placeholders so that literal TTS directive examples inside code are not
 * interpreted as active directives.
 *
 * Returns the masked text and a `restore` function that reverses the masking.
 * Each call generates a unique nonce via `crypto.randomUUID()` to prevent
 * placeholder collisions across concurrent or nested invocations.
 */
function maskCodeBlocks(text: string): { masked: string; restore: (s: string) => string } {
  const identity = (s: string): string => s;
  if (!text.includes("`") && !text.includes("~")) {
    return { masked: text, restore: identity };
  }

  const nonce = crypto.randomUUID().replace(/-/g, "");
  const placeholders: string[] = [];

  const masked = text.replace(CODE_BLOCK_PATTERN, (match) => {
    const index = placeholders.length;
    placeholders.push(match);
    return `${PLACEHOLDER_SENTINEL}${nonce}${index}${PLACEHOLDER_SENTINEL}`;
  });

  const placeholderPattern = new RegExp(
    `${PLACEHOLDER_SENTINEL}${nonce}(\\d+)${PLACEHOLDER_SENTINEL}`,
    "g",
  );
  const restore = (s: string): string =>
    s.replace(
      placeholderPattern,
      (original, index: string) => placeholders[Number(index)] ?? original,
    );

  return { masked, restore };
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
  const { masked, restore } = maskCodeBlocks(text);
  let cleanedText = masked;
  let hasDirective = false;

  const blockRegex = /\[\[tts:text\]\]([\s\S]*?)\[\[\/tts:text\]\]/gi;
  cleanedText = cleanedText.replace(blockRegex, (_match, inner: string) => {
    hasDirective = true;
    if (policy.allowText && overrides.ttsText == null) {
      overrides.ttsText = restore(inner.trim());
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
    return "";
  });

  return {
    cleanedText: restore(cleanedText),
    ttsText: overrides.ttsText,
    hasDirective,
    overrides,
    warnings,
  };
}
