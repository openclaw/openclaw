// GLM <tool_call>exec<arg_key> payload recognition for assistant-visible stripping.
import { skipWhitespace } from "../../../packages/tool-call-repair/src/grammar.js";
import { parseXmlTagAt, type ParsedToolCallTag } from "./xml-tag-at.js";

const GLM_TOOL_NAME_RE = /^[A-Za-z_][\w./:-]*/;
const GLM_ARG_KEY = "arg_key";

// Hold a <tool_call> tool-name / whitespace / partial <arg_key> prefix until
// classified. Name-only and whitespace-only prefixes are stream-only: a later
// replacement cannot unsay an emitted prefix, but a finished answer ending
// `Use <tool_call>exec` is literal prose.
export function isGlmArgPayload(rest: string, streaming: boolean): boolean {
  const name = GLM_TOOL_NAME_RE.exec(rest)?.[0];
  if (!name) {
    return false;
  }
  const start = skipWhitespace(rest, name.length);
  if (start === rest.length) {
    return streaming;
  }
  const open = parseXmlTagAt(rest, start);
  if (!open) {
    return /^<\s*$/.test(rest.slice(start));
  }
  if (open.isClose || open.isSelfClosing || !isGlmArgKeyTag(rest, open)) {
    return false;
  }
  if (open.isTruncated) {
    return true;
  }
  // Only this first key's own close establishes a payload. Never borrow a
  // matching tag from later prose or code examples.
  const keyStart = skipWhitespace(rest, open.end);
  let cursor = keyStart;
  while (cursor < rest.length && !/[\s<]/.test(rest.charAt(cursor))) {
    cursor += 1;
  }
  // GLM trims formatting whitespace around keys. A leading-space prefix is
  // ambiguous with literal `<arg_key> prose` until this first key's own close.
  if (cursor > keyStart) {
    cursor = skipWhitespace(rest, cursor);
  }
  if (cursor === rest.length) {
    return keyStart === open.end || streaming;
  }
  if (keyStart > open.end && cursor === keyStart) {
    return false;
  }
  // A malformed provider close can omit `>` before the outer wrapper. Parse
  // that bounded fragment too, without searching past this first key's close.
  const nextTagStart = rest.indexOf("<", cursor + 1);
  const close =
    parseXmlTagAt(rest, cursor) ??
    (nextTagStart === -1 ? null : parseXmlTagAt(rest.slice(0, nextTagStart), cursor));
  if (!close) {
    return /^<(?:\/\s*)?$/.test(rest.slice(cursor));
  }
  return close.isClose && isGlmArgKeyTag(rest, close);
}

function isGlmArgKeyTag(text: string, tag: ParsedToolCallTag): boolean {
  return (
    tag.tagName === GLM_ARG_KEY ||
    (tag.isTruncated && GLM_ARG_KEY.startsWith(tag.tagName) && tag.contentStart === text.length)
  );
}
