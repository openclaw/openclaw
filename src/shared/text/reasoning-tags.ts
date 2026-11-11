import { reduceReasoningText } from "../../../packages/markdown-core/src/reasoning-tag-syntax.js";
import {
  REASONING_TAG_NAMES,
  scanReasoningTags,
  stripReasoningTagsFromMarkdown,
} from "../../../packages/markdown-core/src/reasoning-tags-batch.js";
import { escapeRegExp } from "../regexp.js";
// Reasoning tag helpers find and remove model reasoning tag blocks from text.
import {
  FINAL_TAG_NAME,
  findFinalTagMatches,
  stripFinalTags,
  finalTagTextFilter,
} from "./final-tags.js";
import { createTagNameProbe } from "./tag-name-probe.js";
import {
  createConditionalTextProjector,
  createTextProjector,
  type TextFilter,
} from "./text-projection.js";
export type ReasoningTagMode = "strict" | "preserve";
export type ReasoningTagTrim = "none" | "start" | "both";
export type ReasoningTagScope = "all" | "leading";

export const THINKING_TAG_NAMES = [
  "think",
  "thinking",
  "thought",
  "antthinking",
  "antml:think",
  "antml:thinking",
  "antml:thought",
  "mm:think",
  "mm:thinking",
  "mm:thought",
] as const;

const REASONING_AND_FINAL_TAG_NAMES = [...REASONING_TAG_NAMES, FINAL_TAG_NAME];
const REASONING_OR_FINAL_TAG_RE = new RegExp(
  `<\\s*\\/?\\s*(?:${REASONING_AND_FINAL_TAG_NAMES.map(escapeRegExp).join("|")})(?=[\\s/>])`,
  "i",
);

/** Detects whether a stray reasoning close tag separates two visible text regions. */
export function hasOrphanReasoningCloseBoundary(params: {
  before: string;
  after: string;
}): boolean {
  return params.before.trim().length > 0 && params.after.trim().length > 0;
}

/** Strips model reasoning/final tags from visible text while preserving literal code examples. */
export function stripReasoningTagsFromText(
  text: string,
  options?: {
    mode?: ReasoningTagMode;
    trim?: ReasoningTagTrim;
    scope?: ReasoningTagScope;
    recoverUnclosed?: boolean;
  },
): string {
  // Without a recognized tag name, both canonical scans preserve the input, including padding.
  if (!text || !REASONING_OR_FINAL_TAG_RE.test(text)) {
    return text;
  }

  const mode = options?.mode ?? "strict";
  const trimMode = options?.trim ?? "both";
  const scope = options?.scope ?? "all";

  let cleaned = text;
  const matches = findFinalTagMatches(cleaned);
  if (matches.length > 0) {
    cleaned = stripFinalTags(cleaned);
  }
  const hasThinkingTag = scanReasoningTags(cleaned).tags.length > 0;
  if (matches.length === 0 && !hasThinkingTag) {
    return text;
  }

  const stripped = hasThinkingTag
    ? stripReasoningTagsFromMarkdown(cleaned, {
        mode,
        scope,
        recoverUnclosed: options?.recoverUnclosed,
      })
    : cleaned;
  if (trimMode === "none") {
    return stripped;
  }
  return trimMode === "start" ? stripped.trimStart() : stripped.trim();
}

/** Final-marker deletion and reasoning reduction own separate Markdown streams. */
export function reasoningTagTextFilter(options: {
  mode: ReasoningTagMode;
  scope: ReasoningTagScope;
  recoverUnclosed: boolean;
}): TextFilter {
  const transform = (text: string) =>
    stripReasoningTagsFromText(text, { ...options, trim: "none" });
  return {
    transform,
    create() {
      const reasoning: TextFilter = {
        transform: (text) => stripReasoningTagsFromMarkdown(text, options),
        create() {
          let facts = { visibleEver: false, rawBefore: false, terminalLiteral: false };
          const reduce = (
            text: string,
            start: number,
            spans: Array<[number, number]>,
            boundary: number,
            final: boolean,
          ) => {
            const state = { depth: 0, visibleEver: facts.visibleEver };
            const effect = { ...facts, boundary, reset: false, lastReset: -1, holdStart: Infinity };
            const output = facts.terminalLiteral
              ? text.slice(start)
              : reduceReasoningText(text, spans, state, {
                  start,
                  scope: options.scope,
                  final,
                  mode: !options.recoverUnclosed
                    ? "hide"
                    : options.mode === "preserve"
                      ? "static-preserve"
                      : "static-strict",
                  checkpoint: effect,
                })
                  .filter((part) => part.kind === "text")
                  .map((part) => part.text)
                  .join("");
            return { output, state, effect };
          };
          return createConditionalTextProjector(
            reasoning.transform,
            createTagNameProbe(REASONING_TAG_NAMES),
            (text, boundary, context) => {
              const start = context.contentStart;
              const spans = context
                .codeRegions()
                .map((region): [number, number] => [region.start, region.end]);
              const preview = reduce(text, start, spans, boundary, true);
              const partial = scanReasoningTags(text.slice(start), false).pendingStart;
              const hold = Math.min(
                preview.effect.holdStart,
                partial === undefined ? Infinity : start + partial,
              );
              // A preview may erase settled text; its facts commit only after the
              // resetting tag and its non-whitespace suffix become Markdown-stable.
              const safe =
                boundary > start && hold >= boundary && preview.effect.lastReset < boundary;
              const committed = safe
                ? reduce(text.slice(0, boundary), start, spans, boundary, false)
                : undefined;
              const canCommit =
                committed !== undefined &&
                committed.effect.holdStart >= boundary &&
                committed.state.depth === 0 &&
                committed.effect.reset === preview.effect.reset;
              return {
                text: text.slice(0, start) + preview.output,
                resetSettled: preview.effect.reset,
                retainStart: canCommit ? boundary : start,
                retainedOutputStart: start + (committed?.output.length ?? 0),
                commit:
                  canCommit && committed
                    ? () => {
                        facts = {
                          visibleEver: committed.state.visibleEver,
                          rawBefore: committed.effect.rawBefore,
                          terminalLiteral: committed.effect.terminalLiteral,
                        };
                      }
                    : undefined,
              };
            },
          );
        },
      };
      return createTextProjector([finalTagTextFilter, reasoning]);
    },
  };
}
