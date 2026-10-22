import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  stripInternalRuntimeContext,
} from "../agents/internal-runtime-context.js";
import { splitTrailingDirective } from "../auto-reply/reply/streaming-directives.js";
import { isRelativeAssistantMediaReference, splitMediaOutput } from "../media/parse-output.js";
import { resolveAssistantEventPhase } from "../shared/chat-message-content.js";
import {
  createConditionalTextProjector,
  createTextProjection,
  type TextFilter,
  type TextProjection,
} from "../shared/text/text-projection.js";
import {
  inlineDirectiveDisplayTextFilter,
  stripInlineDirectiveTagsForDisplay,
} from "../utils/directive-tags.js";
import type { AssistantTextSnapshot } from "./agent-event-assistant-text.js";
import { stripAssistantMediaDirectivesForDisplay } from "./chat-display-projection.helpers.js";

const MAX_LIVE_CHAT_BUFFER_CHARS = 500_000;

/** Cap live display text without letting later snapshots resurrect the retired prefix. */
export function capLiveAssistantText(snapshot: AssistantTextSnapshot): string {
  const { text, scope } = snapshot;
  const capped =
    text.length > MAX_LIVE_CHAT_BUFFER_CHARS
      ? sliceUtf16Safe(text, -MAX_LIVE_CHAT_BUFFER_CHARS)
      : text;
  if (scope) {
    const retired = text.length - capped.length;
    const retiredAfterPrefix = Math.max(0, retired - scope.prefix.length);
    // Retire padding with its prefix, including a cap that cuts through the
    // separator. Later deltas must not recreate or consume those newlines.
    scope.boundaryNewlines =
      retiredAfterPrefix > scope.separatorLength
        ? 0
        : Math.max(0, scope.boundaryNewlines - retiredAfterPrefix);
    scope.separatorLength = Math.max(0, scope.separatorLength - retiredAfterPrefix);
    scope.prefix = sliceUtf16Safe(scope.prefix, retired);
  }
  return capped;
}

/** Removes runtime-only context/directive tags from the merged live assistant buffer. */
export function normalizeLiveAssistantBufferedText(
  text: string,
  options?: {
    final?: boolean;
    managedMediaUrls?: readonly string[];
  },
): string {
  const normalized = stripInternalRuntimeContext(stripInlineDirectiveTagsForDisplay(text).text);
  return stripAssistantMediaDirectivesForDisplay(
    options?.final ? normalized : stripPendingLiveAssistantTail(normalized),
    options?.managedMediaUrls ?? [],
  );
}

function stripPendingLiveAssistantTail(text: string): string {
  const trailing = splitTrailingDirective(text);
  const parsedTail = trailing.tail
    ? splitMediaOutput(trailing.tail, {
        extractAudioDirectives: false,
      })
    : undefined;
  // Hold an ambiguous final line until it is either a client-renderable legacy
  // reference or a relative pipeline directive that the display projection removes.
  return parsedTail?.mediaUrls?.length &&
    parsedTail.mediaUrls.every((url) => !isRelativeAssistantMediaReference(url))
    ? text
    : trailing.text;
}

const pendingLiveAssistantTailFilter: TextFilter = {
  transform: stripPendingLiveAssistantTail,
  create: () => {
    let previousChar = "";
    let openBrackets = false;
    let possibleMediaLine = true;
    let mediaPrefixLength = 0;
    return createConditionalTextProjector(stripPendingLiveAssistantTail, (input) => {
      for (const char of input.delta ?? input.text) {
        if (previousChar === "[" && char === "[") {
          openBrackets = true;
        } else if (previousChar === "]" && char === "]") {
          openBrackets = false;
        }
        previousChar = char;
        if (char === "\n") {
          possibleMediaLine = true;
          mediaPrefixLength = 0;
        } else if (possibleMediaLine && mediaPrefixLength < 5) {
          if (mediaPrefixLength === 0 && /\s/u.test(char)) {
            continue;
          }
          possibleMediaLine = char.toUpperCase() === "MEDIA"[mediaPrefixLength];
          if (possibleMediaLine) {
            mediaPrefixLength += 1;
          }
        }
      }
      // These are negative probes only. The canonical parser still decides whether
      // a bracket or a MEDIA-prefixed line is an incomplete directive or visible text.
      return openBrackets || previousChar === "[" || (possibleMediaLine && mediaPrefixLength > 0);
    });
  },
};

/** One run-owned display chain; replacements rebuild every syntax and visibility probe. */
export function createLiveAssistantTextProjection(options?: {
  managedMediaUrls?: readonly string[];
  final?: boolean;
}) {
  const managedMediaUrls = [...(options?.managedMediaUrls ?? [])];
  const projection = createTextProjection([
    inlineDirectiveDisplayTextFilter,
    {
      activationTokens: [
        INTERNAL_RUNTIME_CONTEXT_BEGIN,
        INTERNAL_RUNTIME_CONTEXT_END,
        "runtime-generated",
      ],
      transform: stripInternalRuntimeContext,
    },
    ...(options?.final ? [] : [pendingLiveAssistantTailFilter]),
    ...(managedMediaUrls.length
      ? [
          {
            activationTokens: ["MEDIA:"],
            transform: (text: string) =>
              stripAssistantMediaDirectivesForDisplay(text, managedMediaUrls),
          },
        ]
      : []),
  ]);
  const present = (result: TextProjection, replace = false) => {
    return {
      text: result.text,
      suppress: !result.text,
      delta: replace ? null : result.delta,
    };
  };
  return {
    get source() {
      return projection.source;
    },
    append: (delta: string, preparedSource?: string) =>
      present(projection.append(delta, preparedSource)),
    replace: (text: string) => present(projection.replace(text), true),
  };
}

/** Projects already-prepared text without interpreting reply control tokens. */
export function projectLiveAssistantBufferedText(rawText: string): {
  text: string;
  suppress: boolean;
} {
  return { text: rawText, suppress: !rawText };
}

/** Returns true when an assistant event phase should not appear in live chat. */
export function shouldSuppressAssistantEventForLiveChat(data: unknown): boolean {
  return resolveAssistantEventPhase(data) === "commentary";
}
