import { findMarkdownCodeSpans } from "../../../packages/markdown-core/src/markdown-code-regions.js";
import {
  isInsideCode,
  scanReasoningTags,
} from "../../../packages/markdown-core/src/reasoning-tag-syntax.js";
import { isSilentReplyText } from "../tokens.js";
import { stripMixedSilentReplyTokens } from "./mixed-silent-reply-tokens.js";

/** Only leading reasoning and whitespace may precede the model's answer envelope. */
export function findReplyEnvelopeStart(source: string): number | undefined {
  if (!/<final>/i.test(source)) {
    return undefined;
  }
  const code = findMarkdownCodeSpans(source);
  let cursor = 0;
  let depth = 0;
  for (const tag of scanReasoningTags(source).tags) {
    if (isInsideCode(tag.index, code)) {
      continue;
    }
    if (depth === 0 && (source.slice(cursor, tag.index).trim() || tag.isClose)) {
      break;
    }
    cursor = tag.index + tag.text.length;
    if (!tag.isSelfClosing) {
      depth += tag.isClose ? -1 : 1;
    }
  }
  const leading = depth === 0 && /^\s*<final>/i.exec(source.slice(cursor));
  if (!leading) {
    return undefined;
  }
  const end = cursor + leading[0].length;
  return isInsideCode(end - "<final>".length, code) ? undefined : end;
}

/** Return source coordinates so preparing a display copy preserves native block boundaries. */
export function readTaggedReplyControl(
  source: string,
): { text: string | undefined; start: number } | undefined {
  const end = /<\/final>\s*$/i.exec(source)?.index;
  if (end === undefined) {
    return undefined;
  }
  const start = findReplyEnvelopeStart(source);
  if (start === undefined || start > end) {
    return undefined;
  }
  const body = source.slice(start, end);
  if (isSilentReplyText(body)) {
    return { text: undefined, start };
  }
  const suffix = stripMixedSilentReplyTokens(body);
  return suffix === null ? undefined : { text: suffix, start: end - suffix.length };
}
