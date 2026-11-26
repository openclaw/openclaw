// Generated inbound context is current-turn model input, never historical display text.
import { safeParseJsonRecord } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { escapeRegExp } from "../../shared/regexp.js";
import type { TextProjection, TextProjector } from "../../shared/text/text-projection.js";
import { MESSAGE_TOOL_DELIVERY_HINTS } from "./delivery-hints.js";
import { INBOUND_CONTEXT_MARKER } from "./inbound-context-marker.js";

const LEADING_TIMESTAMP_PREFIX_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;
const CHANNEL_CONTEXT_HEADER = `Context: ${INBOUND_CONTEXT_MARKER}`;
const ACTIVE_MEMORY_CONTEXT_HEADER = "Context:";
const ACTIVE_MEMORY_OPEN_TAG = "<active_memory_plugin>";
const ACTIVE_MEMORY_CLOSE_TAG = "</active_memory_plugin>";
// Historical producer bytes: this companion preceded the marked JSON hint field.
const LEGACY_REQUESTER_PROFILE_HINT =
  'requester_profile is the verified linked requester. For "assign to me", use sessions assign_owner with ownerType="human" and ownerId=requester_profile.id, if available.';
const INBOUND_METADATA_SENTINELS = [INBOUND_CONTEXT_MARKER, ...MESSAGE_TOOL_DELIVERY_HINTS];
const METADATA_TOKENS_RE = new RegExp(INBOUND_METADATA_SENTINELS.map(escapeRegExp).join("|"), "g");

type TextLine = { start: number; end: number; next: number; trimmed: string };
type LineSpan = { start: number; next: number };

function readTextLine(text: string, start: number): TextLine | undefined {
  if (start > text.length) {
    return undefined;
  }
  const newline = text.indexOf("\n", start);
  const end = newline < 0 ? text.length : newline;
  return { start, end, next: end + 1, trimmed: text.slice(start, end).trim() };
}

function findTextLine(text: string, value: string, from = 0): TextLine | undefined {
  let index = text.indexOf(value, from);
  while (index >= 0) {
    const start = text.lastIndexOf("\n", index - 1) + 1;
    const line = readTextLine(text, start)!;
    if (line.trimmed === value) {
      return line;
    }
    index = text.indexOf(value, line.next);
  }
  return undefined;
}

function skipEmptyLines(text: string, start: number, trimmed = true): number {
  let next = start;
  let line = readTextLine(text, next);
  while (line && (trimmed ? line.trimmed === "" : line.start === line.end)) {
    next = line.next;
    line = readTextLine(text, next);
  }
  return next;
}

function isInboundContextHeaderLine(line: string): boolean {
  return line.length > INBOUND_CONTEXT_MARKER.length && line.endsWith(INBOUND_CONTEXT_MARKER);
}

function isMessageToolDeliveryHintLine(line: string): boolean {
  return MESSAGE_TOOL_DELIVERY_HINTS.some((hint) => hint === line);
}

export function hasInboundMetadataSentinel(text: string): boolean {
  return (
    text.includes(INBOUND_CONTEXT_MARKER) ||
    MESSAGE_TOOL_DELIVERY_HINTS.some((hint) => text.includes(hint)) ||
    // Bare Context: is a sentinel only as a complete line.
    (text.includes(ACTIVE_MEMORY_CONTEXT_HEADER) && /^[ \t]*Context:[ \t]*$/m.test(text))
  );
}

function hasPotentialLeadingTimestamp(text: string): boolean {
  if (!text.startsWith("[")) {
    return false;
  }
  const close = text.indexOf("]");
  if (close >= 0) {
    return LEADING_TIMESTAMP_PREFIX_RE.test(text.slice(0, close + 1));
  }
  // The fixed grammar through minutes is 21 ASCII characters. Once that prefix is
  // complete, every remaining character is part of the timezone until the closer.
  if (text.length >= 21) {
    return LEADING_TIMESTAMP_PREFIX_RE.test(`${text}]`);
  }
  const grammarPrefix =
    /^\[(?:[A-Za-z]{0,3}(?: \d{0,4}(?:-\d{0,2}(?:-\d{0,2}(?: \d{0,2}(?::\d{0,2})?)?)?)?)?)?$/u;
  return grammarPrefix.test(text);
}

function isPotentialDeliveryHintLine(line: string): boolean {
  const candidate = line.trimStart().trimEnd();
  return MESSAGE_TOOL_DELIVERY_HINTS.some((hint) => hint.startsWith(candidate));
}

function isPotentialActiveMemoryHeader(line: string): boolean {
  const candidate = line.trimStart().trimEnd();
  return ACTIVE_MEMORY_CONTEXT_HEADER.startsWith(candidate);
}

function suffixThatMayStartMarker(text: string): number {
  for (
    let length = Math.min(INBOUND_CONTEXT_MARKER.length - 1, text.length);
    length > 0;
    length--
  ) {
    if (INBOUND_CONTEXT_MARKER.startsWith(text.slice(-length))) {
      return length;
    }
  }
  return 0;
}

function trimInboundStreamBoundary(text: string): string {
  let start = 0;
  while (start < text.length) {
    if (text[start] === "\n") {
      start += 1;
    } else if (text[start] === "\r" && text[start + 1] === "\n") {
      start += 2;
    } else {
      break;
    }
  }
  let end = text.length;
  while (end > start) {
    if (text[end - 1] === "\n") {
      end -= 1;
      if (text[end - 1] === "\r") {
        end -= 1;
      }
    } else {
      break;
    }
  }
  return start === 0 && end === text.length ? text : text.slice(start, end);
}

/**
 * Consume complete inbound metadata blocks once and retain only the current line or
 * unfinished block that can still change. The canonical stream can otherwise rescan
 * every preceding byte after its first metadata marker appears.
 */
export function createInboundMetadataStreamProjector(): TextProjector {
  let body = "";
  let cursor = 0;
  let lineStart = 0;
  let lineBodyStart = 0;
  let published = "";
  let discardSuffix = false;
  let holdLine = false;
  let skipBlankLines = false;
  let removedMetadata = false;
  let sourceLength = 0;
  let lineMayStartMetadata = true;
  let passthroughStart: number | null = 0;
  let activeMemorySourceStart: number | null = null;
  let activeMemoryOutputStart: number | null = null;
  let activeMemoryOpen = false;
  let appendOnly = true;

  const reset = () => {
    body = "";
    cursor = 0;
    lineStart = 0;
    lineBodyStart = 0;
    published = "";
    discardSuffix = false;
    holdLine = false;
    skipBlankLines = false;
    removedMetadata = false;
    sourceLength = 0;
    lineMayStartMetadata = true;
    passthroughStart = 0;
    activeMemorySourceStart = null;
    activeMemoryOutputStart = null;
    activeMemoryOpen = false;
    appendOnly = true;
  };

  const materializeTo = (text: string, end: number) => {
    if (passthroughStart === null) {
      return;
    }
    body += text.slice(passthroughStart, end);
    passthroughStart = null;
  };
  const resumePassthrough = (end: number) => {
    if (body.length === 0) {
      passthroughStart = end;
    }
  };
  const currentText = (text: string) => {
    const projected =
      body.length === 0 && passthroughStart !== null ? text.slice(passthroughStart) : body;
    return trimInboundStreamBoundary(projected);
  };
  const startNextLine = (next: number) => {
    cursor = next;
    lineStart = next;
    lineBodyStart = body.length;
    lineMayStartMetadata = true;
  };
  const advanceRaw = (text: string, end: number) => {
    if (passthroughStart === null) {
      body += text.slice(cursor, end);
    }
    cursor = end;
  };
  const prepareCurrentLine = (text: string) => {
    const wasPassthrough = passthroughStart !== null;
    materializeTo(text, lineStart);
    if (wasPassthrough) {
      lineBodyStart = body.length;
    }
    body = body.slice(0, lineBodyStart);
  };
  const holdCurrentLine = (text: string) => {
    prepareCurrentLine(text);
    cursor = lineStart;
    holdLine = true;
    appendOnly = false;
  };

  const jsonBlockLookaheadIsSettled = (text: string, header: TextLine, blockEnd: number) => {
    const first = readTextLine(text, header.next);
    if (first?.trimmed !== "```json") {
      return true;
    }
    const close = findTextLine(text, "```", first.next);
    const parsed = close ? safeParseJsonRecord(text.slice(first.next, close.start)) : null;
    if (!parsed || !isRecord(parsed.requester_profile) || "requester_profile_hint" in parsed) {
      return true;
    }
    // A terminal JSON block can gain the historical requester companion only after
    // a blank separator. Wait for the next complete non-empty line before choosing it.
    let next = skipEmptyLines(text, blockEnd);
    let line = readTextLine(text, next);
    while (line && line.trimmed === "") {
      next = line.next;
      line = readTextLine(text, next);
    }
    return !line || line.next <= text.length;
  };

  const processCompleteLine = (text: string, newline: number): boolean => {
    const next = newline + 1;
    if (holdLine) {
      // The incomplete candidate was projected separately so prefix output stayed
      // canonical. The complete line now owns that output and replaces it atomically.
      body = body.slice(0, lineBodyStart);
      appendOnly = false;
      cursor = lineStart;
      holdLine = false;
    }
    const trimmed = text.slice(lineStart, newline).trim();

    if (activeMemorySourceStart !== null) {
      if (activeMemoryOpen) {
        if (trimmed === ACTIVE_MEMORY_CLOSE_TAG) {
          if (passthroughStart !== null) {
            materializeTo(text, activeMemorySourceStart);
          } else if (activeMemoryOutputStart !== null) {
            body = body.slice(0, activeMemoryOutputStart);
          }
          removedMetadata = true;
          appendOnly = false;
          activeMemorySourceStart = null;
          activeMemoryOutputStart = null;
          activeMemoryOpen = false;
          const resumeAt = skipEmptyLines(text, next);
          resumePassthrough(resumeAt);
          startNextLine(resumeAt);
          skipBlankLines = true;
          return true;
        }
        advanceRaw(text, next);
        startNextLine(next);
        return true;
      }
      if (trimmed === ACTIVE_MEMORY_OPEN_TAG) {
        activeMemoryOpen = true;
        advanceRaw(text, next);
        startNextLine(next);
        return true;
      }
      activeMemorySourceStart = null;
    }

    if (trimmed === ACTIVE_MEMORY_CONTEXT_HEADER) {
      activeMemorySourceStart = lineStart;
      activeMemoryOutputStart = body.length;
      advanceRaw(text, next);
      startNextLine(next);
      return true;
    }

    if (isMessageToolDeliveryHintLine(trimmed)) {
      prepareCurrentLine(text);
      removedMetadata = true;
      appendOnly = false;
      resumePassthrough(next);
      startNextLine(next);
      return true;
    }
    if (trimmed === CHANNEL_CONTEXT_HEADER) {
      prepareCurrentLine(text);
      removedMetadata = true;
      appendOnly = false;
      discardSuffix = true;
      cursor = text.length;
      resumePassthrough(cursor);
      return false;
    }
    if (isInboundContextHeaderLine(trimmed)) {
      prepareCurrentLine(text);
      appendOnly = false;
      const header = readTextLine(text, lineStart)!;
      const blockEnd = metadataBlockEnd(text, header);
      if (blockEnd > text.length) {
        holdCurrentLine(text);
        return false;
      }
      if (!jsonBlockLookaheadIsSettled(text, header, blockEnd)) {
        holdCurrentLine(text);
        return false;
      }
      removedMetadata = true;
      resumePassthrough(blockEnd);
      startNextLine(blockEnd);
      return true;
    }

    advanceRaw(text, next);
    startNextLine(next);
    return true;
  };

  const processIncompleteLine = (text: string) => {
    if (
      activeMemorySourceStart !== null &&
      activeMemoryOpen &&
      text.slice(lineStart).trim() === ACTIVE_MEMORY_CLOSE_TAG
    ) {
      if (passthroughStart !== null) {
        materializeTo(text, activeMemorySourceStart);
      } else if (activeMemoryOutputStart !== null) {
        body = body.slice(0, activeMemoryOutputStart);
      }
      removedMetadata = true;
      appendOnly = false;
      activeMemorySourceStart = null;
      activeMemoryOutputStart = null;
      activeMemoryOpen = false;
      cursor = text.length;
      resumePassthrough(cursor);
      lineStart = cursor;
      lineBodyStart = body.length;
      skipBlankLines = true;
      return;
    }
    let lineStartCandidate = false;
    if (lineMayStartMetadata) {
      const startProbe = text.slice(lineStart, Math.min(text.length, lineStart + 512));
      const withoutLeading = startProbe.trimStart();
      const first = withoutLeading.charAt(0);
      if (first && first !== "C" && first !== "D") {
        lineMayStartMetadata = false;
      } else {
        const maxHint = Math.max(...MESSAGE_TOOL_DELIVERY_HINTS.map((hint) => hint.length));
        const candidate = text.slice(
          lineStart + (startProbe.length - withoutLeading.length),
          Math.min(text.length, lineStart + 512 + maxHint),
        );
        if (!isPotentialActiveMemoryHeader(candidate) && !isPotentialDeliveryHintLine(candidate)) {
          lineMayStartMetadata = false;
        } else {
          lineStartCandidate = true;
        }
      }
    }
    const markerStart = text.indexOf(
      INBOUND_CONTEXT_MARKER,
      Math.max(lineStart, cursor - INBOUND_CONTEXT_MARKER.length + 1),
    );
    const tailStart = Math.max(cursor, lineStart, text.length - INBOUND_CONTEXT_MARKER.length + 1);
    const markerTail = suffixThatMayStartMarker(text.slice(tailStart));
    if (holdLine || markerStart >= 0 || lineStartCandidate || markerTail > 0) {
      // The mutable candidate is bounded by one line. Canonicalizing that line keeps
      // every streamed prefix consistent without rescanning the settled reply.
      prepareCurrentLine(text);
      appendOnly = false;
      body += stripInboundMetadata(text.slice(lineStart));
      cursor = text.length;
      holdLine = true;
      return;
    }
    advanceRaw(text, text.length);
  };

  const process = (text: string) => {
    if (discardSuffix) {
      cursor = text.length;
      return;
    }
    while (cursor < text.length) {
      if (skipBlankLines) {
        const newline = text.indexOf("\n", cursor);
        if (newline < 0) {
          if (text.slice(cursor).trim() !== "") {
            skipBlankLines = false;
          } else {
            return;
          }
        } else {
          if (text.slice(cursor, newline).trim() === "") {
            cursor = newline + 1;
            lineStart = cursor;
            lineBodyStart = body.length;
            continue;
          }
          skipBlankLines = false;
        }
      }

      if ((cursor === 0 || removedMetadata) && body.length === 0) {
        const remaining = text.slice(cursor);
        const timestamp = LEADING_TIMESTAMP_PREFIX_RE.exec(remaining);
        if (timestamp?.index === 0) {
          const timestampEnd = cursor + timestamp[0].length;
          materializeTo(text, cursor);
          resumePassthrough(timestampEnd);
          removedMetadata = true;
          appendOnly = false;
          cursor = timestampEnd;
          lineStart = cursor;
          lineBodyStart = body.length;
          continue;
        }
        if (hasPotentialLeadingTimestamp(remaining)) {
          prepareCurrentLine(text);
          appendOnly = false;
          body += stripInboundMetadata(remaining);
          cursor = text.length;
          holdLine = true;
          return;
        }
      }

      const newline = text.indexOf("\n", cursor);
      if (newline < 0) {
        processIncompleteLine(text);
        return;
      }
      if (!processCompleteLine(text, newline)) {
        return;
      }
    }
  };

  const result = (input: TextProjection, text: string, delta: string | null): TextProjection => {
    const previous = published;
    published = text;
    const nextDelta =
      delta === null
        ? null
        : appendOnly && text.length >= previous.length
          ? text.slice(previous.length)
          : text.startsWith(previous)
            ? text.slice(previous.length)
            : null;
    appendOnly = true;
    return text === input.text && nextDelta === input.delta ? input : { text, delta: nextDelta };
  };

  const projector: TextProjector = (input) => {
    if (input.delta === "") {
      return { text: currentText(input.text), delta: "" };
    }
    if (input.delta === null) {
      reset();
      sourceLength = input.text.length;
      process(input.text);
      return result(input, currentText(input.text), null);
    }
    if (input.text.length !== sourceLength + input.delta.length) {
      reset();
    }
    sourceLength = input.text.length;
    process(input.text);
    return result(input, currentText(input.text), input.delta);
  };

  return projector;
}

/** Probe appended bytes only until canonical metadata can affect the visible text. */
export function createInboundMetadataProbe(): (input: TextProjection) => boolean {
  const scanOverlap = Math.max(...INBOUND_METADATA_SENTINELS.map((token) => token.length - 1));
  let active = false;
  let tail = "";
  let contextOffset = 0;
  let timestampHead: string | null = "";
  let timestampOpen = false;
  return ({ text, delta }) => {
    if (active) {
      return true;
    }
    const appended = delta ?? text;
    const scan = tail + appended;
    tail = scan.slice(-scanOverlap);
    if (INBOUND_METADATA_SENTINELS.some((token) => scan.includes(token))) {
      active = true;
      return true;
    }
    let timestampTail = appended;
    if (timestampHead !== null) {
      // The fixed timestamp grammar through minutes is 21 ASCII characters.
      const needed = 21 - timestampHead.length;
      timestampHead += appended.slice(0, needed);
      timestampTail = appended.slice(needed);
      if (timestampHead.length === 21) {
        timestampOpen = LEADING_TIMESTAMP_PREFIX_RE.test(timestampHead + "]");
        timestampHead = null;
      }
    }
    if (timestampOpen && timestampTail.includes("]")) {
      active = true;
      return true;
    }
    for (const char of appended) {
      if (char === "\n" || char === "\r" || char === "\u2028" || char === "\u2029") {
        if (contextOffset === ACTIVE_MEMORY_CONTEXT_HEADER.length) {
          active = true;
          return true;
        }
        contextOffset = 0;
      } else if (char === " " || char === "\t") {
        if (contextOffset !== 0 && contextOffset !== ACTIVE_MEMORY_CONTEXT_HEADER.length) {
          contextOffset = -1;
        }
      } else if (contextOffset >= 0 && char === ACTIVE_MEMORY_CONTEXT_HEADER[contextOffset]) {
        contextOffset++;
      } else {
        contextOffset = -1;
      }
    }
    // Complete lines follow JavaScript's line boundaries, like the canonical sentinel.
    // At EOF, don't latch: the next delta may turn Context: into ordinary inline prose.
    return contextOffset === ACTIVE_MEMORY_CONTEXT_HEADER.length;
  };
}

function metadataBlockEnd(text: string, header: TextLine): number {
  let line = readTextLine(text, header.next);
  if (line?.trimmed === "```json") {
    const close = findTextLine(text, "```", line.next);
    if (!close) {
      return text.length + 1;
    }
    const hint = readTextLine(text, skipEmptyLines(text, close.next));
    const separator = hint && readTextLine(text, hint.next);
    if (
      header.trimmed === `Conversation info: ${INBOUND_CONTEXT_MARKER}` &&
      hint &&
      hint.start > close.next &&
      text.slice(hint.start, hint.end).replace(/\r$/u, "") === LEGACY_REQUESTER_PROFILE_HINT &&
      (!separator || separator.trimmed === "")
    ) {
      const metadata = safeParseJsonRecord(text.slice(line.next, close.start));
      if (
        metadata &&
        isRecord(metadata.requester_profile) &&
        !("requester_profile_hint" in metadata)
      ) {
        // The old companion belongs to this block, not to later quoted user text.
        return skipEmptyLines(text, hint.next);
      }
    }
    return close.next;
  }
  // Generated prose context ends at the next blank separator, including its blanks.
  while (line && line.trimmed !== "") {
    line = readTextLine(text, line.next);
  }
  return skipEmptyLines(text, line?.start ?? text.length + 1);
}

function removeLineSpans(text: string, spans: LineSpan[]): string {
  if (spans.length === 0) {
    return text;
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    // A removed final line also owns the preceding separator, like split/filter/join.
    const start = span.next > text.length && span.start > 0 ? span.start - 1 : span.start;
    parts.push(text.slice(cursor, Math.max(cursor, start)));
    cursor = span.next;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

function stripActiveMemoryPromptPrefixBlocks(text: string): string {
  if (!text.includes(ACTIVE_MEMORY_OPEN_TAG)) {
    return text;
  }
  const spans: LineSpan[] = [];
  let header = findTextLine(text, ACTIVE_MEMORY_CONTEXT_HEADER);
  while (header) {
    const open = readTextLine(text, header.next);
    const close =
      open?.trimmed === ACTIVE_MEMORY_OPEN_TAG
        ? findTextLine(text, ACTIVE_MEMORY_CLOSE_TAG, open.next)
        : undefined;
    const next = close ? skipEmptyLines(text, close.next) : header.next;
    if (close) {
      spans.push({ start: header.start, next });
    }
    header = findTextLine(text, ACTIVE_MEMORY_CONTEXT_HEADER, next);
  }
  return removeLineSpans(text, spans);
}

function stripTrailingContextBlockSuffix(text: string): string {
  const header = findTextLine(text, CHANNEL_CONTEXT_HEADER);
  if (!header) {
    return text;
  }
  let end = header.start;
  while (end > 0) {
    const previous = end === 1 ? 0 : text.lastIndexOf("\n", end - 2) + 1;
    if (text.slice(previous, end - 1).trim() !== "") {
      break;
    }
    end = previous;
  }
  return text.slice(0, Math.max(0, end - 1));
}

/** Strips all injected inbound metadata blocks from user-visible text. */
export function stripInboundMetadata(text: string): string {
  const withoutTimestamp = text.replace(LEADING_TIMESTAMP_PREFIX_RE, "");
  if (!hasInboundMetadataSentinel(withoutTimestamp)) {
    return withoutTimestamp;
  }
  // Active-memory removal precedes fence parsing, including blocks inside metadata JSON.
  const source = stripActiveMemoryPromptPrefixBlocks(withoutTimestamp);
  const spans: LineSpan[] = [];
  const tokens = new RegExp(METADATA_TOKENS_RE);
  let match: RegExpExecArray | null;
  while ((match = tokens.exec(source))) {
    const start = source.lastIndexOf("\n", match.index - 1) + 1;
    const line = readTextLine(source, start)!;
    tokens.lastIndex = line.next;
    if (line.trimmed === CHANNEL_CONTEXT_HEADER) {
      spans.push({ start, next: source.length + 1 });
      break;
    }
    if (isInboundContextHeaderLine(line.trimmed)) {
      tokens.lastIndex = metadataBlockEnd(source, line);
      spans.push({ start, next: tokens.lastIndex });
    } else if (isMessageToolDeliveryHintLine(line.trimmed)) {
      spans.push({ start, next: line.next });
    }
  }
  return removeLineSpans(source, spans)
    .replace(/^(?:\r?\n)+/u, "")
    .replace(/(?:\r?\n)+$/u, "")
    .replace(LEADING_TIMESTAMP_PREFIX_RE, "");
}

/** Returns the leading metadata boundary without rewriting any later content. */
function readLeadingInboundMetadataEnd(text: string): number {
  let start = skipEmptyLines(text, 0, false);
  let line = readTextLine(text, start);
  const strippedDeliveryHint = Boolean(line && isMessageToolDeliveryHintLine(line.trimmed));
  while (line && isMessageToolDeliveryHintLine(line.trimmed)) {
    start = skipEmptyLines(text, line.next, false);
    line = readTextLine(text, start);
  }
  if (!line) {
    return text.length;
  }
  if (!isInboundContextHeaderLine(line.trimmed)) {
    return strippedDeliveryHint ? Math.min(start, text.length) : 0;
  }
  while (line && isInboundContextHeaderLine(line.trimmed)) {
    start = skipEmptyLines(text, metadataBlockEnd(text, line));
    line = readTextLine(text, start);
  }
  return Math.min(start, text.length);
}

/** Strips only leading inbound metadata blocks while preserving later user text. */
export function stripLeadingInboundMetadata(text: string): string {
  if (!hasInboundMetadataSentinel(text)) {
    return text;
  }
  const source = stripActiveMemoryPromptPrefixBlocks(text);
  return stripTrailingContextBlockSuffix(source.slice(readLeadingInboundMetadataEnd(source)));
}

function parseInboundMetaBlock(text: string, label: string): Record<string, unknown> | null {
  const header = findTextLine(text, `${label} ${INBOUND_CONTEXT_MARKER}`);
  const open = header && readTextLine(text, header.next);
  if (open?.trimmed !== "```json") {
    return null;
  }
  const close = findTextLine(text, "```", open.next);
  return close ? (safeParseJsonRecord(text.slice(open.next, close.start).trim()) ?? null) : null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      // Only selected label strings escape the parser; do not recursively clone metadata.
      return value.trim().replaceAll("`\u200b``", "```");
    }
  }
  return null;
}

export function extractInboundSenderLabel(text: string): string | null {
  if (!text.includes(INBOUND_CONTEXT_MARKER)) {
    return null;
  }
  const sender = parseInboundMetaBlock(text, "Sender:");
  const label = firstNonEmptyString(
    sender?.label,
    sender?.name,
    sender?.username,
    sender?.e164,
    sender?.id,
  );
  if (label) {
    return label;
  }
  const conversationSender = parseInboundMetaBlock(text, "Conversation info:")?.sender;
  return isRecord(conversationSender)
    ? firstNonEmptyString(
        conversationSender.name,
        conversationSender.username,
        conversationSender.e164,
        conversationSender.id,
      )
    : firstNonEmptyString(conversationSender);
}
