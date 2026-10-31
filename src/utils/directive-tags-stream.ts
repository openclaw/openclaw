import {
  canReuseMarkdownOwnershipForAppend,
  findCodeOwnership,
} from "../shared/text/code-regions.js";
import {
  createTextProjector,
  type TextFilter,
  type TextProjector,
} from "../shared/text/text-projection.js";
import {
  stripAudioTagsForDisplay,
  stripInlineDirectiveTagsForDisplay,
  stripReplyTagsForDisplay,
} from "./directive-tags-batch.js";

/** Raw offsets for literal directives whose Markdown code ownership is settled. */
export type StreamDirectiveCodePrefix = {
  end: number;
  checkedRawLength: number;
};

function hasDirectiveCodePrefixOpportunity(source: string, delta: string): boolean {
  if (!delta) {
    return false;
  }
  const deltaStart = source.length - delta.length;
  const start = Math.max(0, deltaStart - 4);
  let separator = -1;
  // A following line can close block code without a blank separator; ownership proves stability.
  for (const match of source.slice(start).matchAll(/(?:\r\n|\n|\r)[^\S\r\n]*\S/g)) {
    if (start + match.index + match[0].length > deltaStart) {
      separator = start + match.index;
    }
  }
  if (separator === -1) {
    return false;
  }
  const lastMarker = source.lastIndexOf("[[");
  return lastMarker !== -1 && separator > lastMarker;
}

export function findDirectiveCodePrefix(
  source: string,
  delta: string,
): StreamDirectiveCodePrefix | undefined {
  if (!hasDirectiveCodePrefixOpportunity(source, delta)) {
    return undefined;
  }
  const { regions, retainStart, completedParagraphs } = findCodeOwnership(source);
  let regionIndex = 0;
  let paragraphIndex = 0;
  let end = 0;
  for (
    let marker = source.indexOf("[[");
    marker !== -1;
    marker = source.indexOf("[[", marker + 1)
  ) {
    let region = regions[regionIndex];
    while (region && region.end <= marker) {
      region = regions[++regionIndex];
    }
    let paragraph = completedParagraphs[paragraphIndex];
    while (paragraph && paragraph.end <= marker) {
      paragraph = completedParagraphs[++paragraphIndex];
    }
    if (!region || region.start > marker || region.end < marker + 2) {
      return undefined;
    }
    if (region.block) {
      if (region.end > retainStart) {
        return undefined;
      }
      end = region.end;
      continue;
    }
    if (
      !paragraph ||
      paragraph.hasReferenceCandidate ||
      paragraph.start > region.start ||
      paragraph.end < region.end
    ) {
      return undefined;
    }
    end = paragraph.end;
  }
  return end ? { end, checkedRawLength: source.length } : undefined;
}

/** Prose appends cannot open directive syntax or change Markdown code ownership. */
const APPEND_SAFE_DELTA = /^[^[`~]*$/u;

function hasUnsettledDirectiveMarker(source: string): boolean {
  const marker = source.lastIndexOf("[[");
  return marker !== -1 && source.lastIndexOf("]]") < marker;
}

/** Retain only literal directives whose Markdown ownership cannot change on append. */
const replyDirectiveDisplayTextFilter: TextFilter = {
  transform: stripReplyTagsForDisplay,
  create: (): TextProjector => {
    let prefix: StreamDirectiveCodePrefix | undefined;
    let hasMarker = false;
    let previousChar = "";
    let source = "";
    let visible = "";
    let identity = true;
    // A settled reply only re-parses when a delta can still change directive syntax.
    let settledMarker = true;
    let visibleMarker = false;
    let ownership: ReturnType<typeof findCodeOwnership> | undefined;
    const projector: TextProjector = (input) => {
      const appended = input.delta;
      if (appended === null) {
        source = input.text;
        visible = stripReplyTagsForDisplay(source);
        prefix = visible === source ? findDirectiveCodePrefix(source, source) : undefined;
        hasMarker = source.includes("[[");
        settledMarker = !hasUnsettledDirectiveMarker(source);
        visibleMarker = hasUnsettledDirectiveMarker(visible);
        identity = visible === source;
        ownership = undefined;
        previousChar = source.slice(-1);
        return { text: visible, delta: null };
      }
      if (appended === "") {
        return { text: visible, delta: "" };
      }
      // The projection owner extends its settled result instead of re-parsing the whole
      // reply per delta once no `[`, code marker, or open directive can still change it.
      if (
        (prefix !== undefined || (settledMarker && !visibleMarker)) &&
        source.length + appended.length === input.text.length &&
        APPEND_SAFE_DELTA.test(appended) &&
        (!hasMarker ||
          canReuseMarkdownOwnershipForAppend(
            source,
            appended,
            (ownership ??= findCodeOwnership(source)),
          ))
      ) {
        source = input.text;
        previousChar = appended.slice(-1);
        if (identity) {
          visible = source;
          return input;
        }
        visible += appended;
        return { text: visible, delta: appended };
      }
      const previousVisible = visible;
      if ((previousChar + appended).includes("[[")) {
        hasMarker = true;
        prefix = undefined;
      }
      previousChar = appended.slice(-1);
      source = input.text;
      if (hasMarker && !prefix) {
        visible = stripReplyTagsForDisplay(source);
        prefix = visible === source ? findDirectiveCodePrefix(source, appended) : undefined;
      } else {
        visible = source;
      }
      settledMarker = !hasUnsettledDirectiveMarker(source);
      visibleMarker = hasUnsettledDirectiveMarker(visible);
      identity = visible === source;
      ownership = undefined;
      if (identity) {
        return input;
      }
      return {
        text: visible,
        delta:
          visible === previousVisible
            ? ""
            : visible.startsWith(previousVisible)
              ? visible.slice(previousVisible.length)
              : null,
      };
    };
    return projector;
  },
};

/** Settles at Markdown checkpoints, so growing prose never re-parses the settled prefix. */
const audioDirectiveDisplayTextFilter: TextFilter = {
  transform: stripAudioTagsForDisplay,
  activationTokens: ["audio_as_voice"],
  checkpoint: (text, boundary, context) => {
    const safe =
      boundary > context.contentStart && !hasUnsettledDirectiveMarker(text.slice(0, boundary));
    return {
      text: stripAudioTagsForDisplay(text),
      retainStart: safe ? boundary : context.contentStart,
      retainedOutputStart: safe
        ? stripAudioTagsForDisplay(text.slice(0, boundary)).length
        : context.contentStart,
    };
  },
};

/** Canonical order: audio tags go first and can expose code that owns reply tags. */
export const inlineDirectiveDisplayTextFilter: TextFilter = {
  transform: (text) => stripInlineDirectiveTagsForDisplay(text).text,
  create: () =>
    createTextProjector([audioDirectiveDisplayTextFilter, replyDirectiveDisplayTextFilter]),
};
