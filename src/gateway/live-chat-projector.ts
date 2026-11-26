import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { runtimeContextStreamingTextFilter } from "../agents/internal-runtime-context-stream.js";
import { stripInternalRuntimeContext } from "../agents/internal-runtime-context.js";
import { splitTrailingDirective } from "../auto-reply/reply/streaming-directives.js";
import { isRelativeAssistantMediaReference, splitMediaOutput } from "../media/parse-output.js";
import { resolveAssistantEventPhase } from "../shared/chat-message-content.js";
import {
  createConditionalTextProjector,
  createTextProjection,
  type TextFilter,
  type TextProjection,
  type TextProjector,
} from "../shared/text/text-projection.js";
import {
  inlineDirectiveDisplayTextFilter,
  stripInlineDirectiveTagsForDisplay,
} from "../utils/directive-tags.js";
import type { AssistantTextSnapshot } from "./agent-event-assistant-text.js";
import { stripAssistantMediaDirectivesForDisplay } from "./chat-display-projection.helpers.js";

const MAX_LIVE_CHAT_BUFFER_CHARS = 500_000;
const MEDIA_DIRECTIVE_PREFIX = "MEDIA:";

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
    streaming?: boolean;
  },
): string {
  const normalized = stripInternalRuntimeContext(
    stripInlineDirectiveTagsForDisplay(text).text,
    options?.streaming && !options.final ? { streaming: true } : undefined,
  );
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

function hasRemovedTrailingMediaDirective(source: string, visible: string): boolean {
  let end = source.length;
  while (end > 0 && /\s/u.test(source[end - 1] ?? "")) {
    end -= 1;
  }
  if (end === 0) {
    return false;
  }
  const lineStart =
    Math.max(source.lastIndexOf("\n", end - 1), source.lastIndexOf("\r", end - 1)) + 1;
  const line = source.slice(lineStart, end);
  return /^\s*MEDIA:/iu.test(line) && !visible.trimEnd().endsWith(line);
}

/** Parse complete managed-media lines once, then extend only Markdown-safe prose. */
function createMediaDirectiveDisplayFilter(
  managedMediaUrls: readonly string[],
  final: boolean,
): TextFilter {
  const transform = (text: string) =>
    stripAssistantMediaDirectivesForDisplay(text, managedMediaUrls);
  if (final) {
    return { activationTokens: [MEDIA_DIRECTIVE_PREFIX], transform };
  }

  return {
    transform,
    create: (): TextProjector => {
      let source = "";
      let visible = "";
      let identity = true;
      let active = false;
      let mediaRemovalPending = false;
      let pendingTrailingWhitespace = "";
      let lineStart = 0;
      let linePrefixLength = 0;
      let linePrefixPossible = true;
      let linePrefixComplete = false;
      let lineHasContent = false;
      let lineHasNonWhitespace = false;

      const capturePendingTrailingWhitespace = () => {
        const sourceTrailingWhitespace = source.match(/\s*$/u)?.[0] ?? "";
        const visibleTrailingWhitespace = visible.match(/\s*$/u)?.[0] ?? "";
        let sharedSuffixLength = 0;
        while (
          sharedSuffixLength < sourceTrailingWhitespace.length &&
          sharedSuffixLength < visibleTrailingWhitespace.length &&
          sourceTrailingWhitespace[sourceTrailingWhitespace.length - sharedSuffixLength - 1] ===
            visibleTrailingWhitespace[visibleTrailingWhitespace.length - sharedSuffixLength - 1]
        ) {
          sharedSuffixLength += 1;
        }
        pendingTrailingWhitespace = sourceTrailingWhitespace.slice(
          0,
          sourceTrailingWhitespace.length - sharedSuffixLength,
        );
      };

      const resetLineProbe = (text: string) => {
        lineStart = 0;
        linePrefixLength = 0;
        linePrefixPossible = true;
        linePrefixComplete = false;
        lineHasContent = false;
        lineHasNonWhitespace = false;
        for (let index = 0; index < text.length; index += 1) {
          const char = text[index] ?? "";
          if (char === "\r" || char === "\n") {
            lineStart = index + 1;
            linePrefixLength = 0;
            linePrefixPossible = true;
            linePrefixComplete = false;
            lineHasContent = false;
            lineHasNonWhitespace = false;
            continue;
          }
          lineHasContent = true;
          lineHasNonWhitespace ||= /\S/u.test(char);
          if (!linePrefixPossible || linePrefixComplete) {
            continue;
          }
          if (linePrefixLength === 0 && /\s/u.test(char)) {
            continue;
          }
          if (char.toUpperCase() === MEDIA_DIRECTIVE_PREFIX[linePrefixLength]) {
            linePrefixLength += 1;
            linePrefixComplete = linePrefixLength === MEDIA_DIRECTIVE_PREFIX.length;
          } else {
            linePrefixPossible = false;
          }
        }
      };

      const reset = (text: string) => {
        source = text;
        visible = transform(text);
        identity = visible === source;
        active = /(?:^|[\r\n])\s*MEDIA:/iu.test(source);
        mediaRemovalPending = hasRemovedTrailingMediaDirective(source, visible);
        capturePendingTrailingWhitespace();
        resetLineProbe(source);
        return { text: visible, delta: null };
      };

      const projector: TextProjector = (input) => {
        const appended = input.delta;
        if (appended === null) {
          return reset(input.text);
        }
        if (appended === "") {
          return identity ? input : { text: visible, delta: "" };
        }
        if (input.text.length !== source.length + appended.length) {
          return reset(input.text);
        }

        let completedMediaLine: { start: number; end: number } | undefined;
        let completedWhitespaceOnlyLine = false;
        let nonWhitespaceAfterMediaLine = false;
        let resolvedPendingMediaRemoval = false;
        for (let index = 0; index < appended.length; index += 1) {
          const char = appended[index] ?? "";
          const offset = source.length + index;
          if (char === "\r" || char === "\n") {
            completedWhitespaceOnlyLine ||= lineHasContent && !lineHasNonWhitespace;
            if (linePrefixComplete) {
              completedMediaLine = { start: lineStart, end: offset + 1 };
              nonWhitespaceAfterMediaLine = false;
            }
            lineStart = offset + 1;
            linePrefixLength = 0;
            linePrefixPossible = true;
            linePrefixComplete = false;
            lineHasContent = false;
            lineHasNonWhitespace = false;
            continue;
          }

          lineHasContent = true;
          lineHasNonWhitespace ||= /\S/u.test(char);
          if (completedMediaLine && /\S/u.test(char)) {
            nonWhitespaceAfterMediaLine = true;
          }
          if (linePrefixPossible && !linePrefixComplete) {
            if (linePrefixLength === 0 && /\s/u.test(char)) {
              continue;
            }
            if (char.toUpperCase() === MEDIA_DIRECTIVE_PREFIX[linePrefixLength]) {
              linePrefixLength += 1;
              linePrefixComplete = linePrefixLength === MEDIA_DIRECTIVE_PREFIX.length;
            } else {
              linePrefixPossible = false;
            }
          }
          if (
            mediaRemovalPending &&
            /\S/u.test(char) &&
            !linePrefixPossible &&
            !linePrefixComplete
          ) {
            resolvedPendingMediaRemoval = true;
          }
        }

        if (!active && !completedMediaLine) {
          source = input.text;
          return input;
        }
        active ||= Boolean(completedMediaLine);
        // Once a media line is removed, later prose cannot make it block code or
        // change its ownership. Defer another parse until a new MEDIA line completes.
        const appendSafe = !active || (!linePrefixComplete && !completedWhitespaceOnlyLine);
        if (!completedMediaLine && !resolvedPendingMediaRemoval && appendSafe) {
          source = input.text;
          if (mediaRemovalPending) {
            identity = visible === source;
            return { text: visible, delta: "" };
          }
          if (identity) {
            visible = source;
            return input;
          }
          const nextVisible = pendingTrailingWhitespace + appended;
          const stableEnd = nextVisible.search(/\s*$/u);
          const stableAppend = nextVisible.slice(0, stableEnd);
          pendingTrailingWhitespace = nextVisible.slice(stableEnd);
          visible += stableAppend;
          return { text: visible, delta: stableAppend };
        }

        const previousVisible = visible;
        source = input.text;
        visible = transform(source);
        identity = visible === source;
        capturePendingTrailingWhitespace();
        if (completedMediaLine && !nonWhitespaceAfterMediaLine) {
          const line = source.slice(completedMediaLine.start, completedMediaLine.end).trimEnd();
          mediaRemovalPending = Boolean(line) && !visible.trimEnd().endsWith(line);
        } else if (resolvedPendingMediaRemoval) {
          mediaRemovalPending = false;
        }
        const delta =
          visible === previousVisible
            ? ""
            : visible.startsWith(previousVisible)
              ? visible.slice(previousVisible.length)
              : null;
        return identity && delta === appended ? input : { text: visible, delta };
      };
      return projector;
    },
  };
}

/** One run-owned display chain; replacements rebuild every syntax and visibility probe. */
export function createLiveAssistantTextProjection(options?: {
  managedMediaUrls?: readonly string[];
  final?: boolean;
}) {
  const managedMediaUrls = [...(options?.managedMediaUrls ?? [])];
  const projection = createTextProjection([
    inlineDirectiveDisplayTextFilter,
    runtimeContextStreamingTextFilter,
    ...(options?.final ? [] : [pendingLiveAssistantTailFilter]),
    ...(managedMediaUrls.length
      ? [createMediaDirectiveDisplayFilter(managedMediaUrls, Boolean(options?.final))]
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
