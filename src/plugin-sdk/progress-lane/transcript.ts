/**
 * Channel-neutral transcript model for the shared progress-lane engine.
 *
 * Pure, dependency-free body math hoisted from the Telegram interleaved lane
 * (#87072): accumulate a body, convert cumulative reasoning snapshots to suffix
 * deltas with cross-stream overlap-fold dedup, append timestamped status lines,
 * roll over (`computeSpill`) before a channel's char cap, render a neutral body
 * (header + body + rolling timer), and strip a final answer that leaked in.
 *
 * The body is neutral markup (`_italic_` reasoning lines, `[HH:MM:SS] tool`
 * rows). Each channel sink formats it to its surface (Telegram HTML, Discord
 * markdown, card blocks). Engine owns *what* to show; the sink owns *how*.
 */

/** Max chars kept from any single status line. */
export const LANE_LINE_MAX_CHARS = 200;

/** Rolling-timer tick interval. Slow enough that concurrent edits stay under a
 * chat's edit-rate limit (Telegram 429s); overridable per channel. */
export const LANE_TIMER_INTERVAL_MS = 20_000;

/** Default body budget before rollover. Channels pass their own cap
 * (Telegram 4096 → 3900 with margin; Discord 2000; card limits). */
export const LANE_MESSAGE_MAX_CHARS = 3900;

/** Trailing chars carried into a continuation message on rollover. */
export const LANE_SPILL_OVERLAP_CHARS = 600;

/** Decide whether the body has outgrown the current message and where the
 * continuation should start (line-snapped, carrying recent context). */
export function computeSpill(params: {
  body: string;
  offset: number;
  maxChars?: number;
  overlapChars?: number;
}): { offset: number; spilled: boolean } {
  const maxChars = params.maxChars ?? LANE_MESSAGE_MAX_CHARS;
  const overlap = params.overlapChars ?? LANE_SPILL_OVERLAP_CHARS;
  const offset = Math.max(0, Math.min(params.offset, params.body.length));
  if (params.body.length - offset <= maxChars) {
    return { offset, spilled: false };
  }
  let newOffset = Math.max(offset, params.body.length - overlap);
  const nl = params.body.indexOf("\n", newOffset);
  if (nl >= 0 && nl < params.body.length - 1) {
    newOffset = nl + 1;
  }
  // Single huge lines have no clean rollover point.
  if (newOffset <= offset) {
    newOffset = Math.max(offset, params.body.length - Math.min(overlap, maxChars));
  }
  return { offset: newOffset, spilled: newOffset > offset };
}

export function sanitizeLaneLine(line: string, maxChars: number = LANE_LINE_MAX_CHARS): string {
  return line.replace(/\s+/gu, " ").trim().slice(0, maxChars);
}

/** Render the neutral body: header + content + (while running) a rolling timer
 * with a wall-clock stamp. Empty + no timer → "" so the lane never emits a bare
 * header. `maxChars` tail-caps so a single oversize render can't exceed the cap. */
export function renderLaneBody(params: {
  body: string;
  header?: string;
  timerStartedAt?: number;
  now?: number;
  maxChars?: number;
}): string {
  const header = params.header ?? "Thinking";
  const now = params.now ?? Date.now();
  let body = params.body.trimEnd();
  if (body === "" && params.timerStartedAt === undefined) {
    return "";
  }
  let timerSuffix = "";
  if (params.timerStartedAt !== undefined) {
    const elapsed = Math.floor((now - params.timerStartedAt) / 1000);
    const c = new Date(now);
    const pad2 = (n: number): string => String(n).padStart(2, "0");
    const clock = `${pad2(c.getHours())}:${pad2(c.getMinutes())}:${pad2(c.getSeconds())}`;
    timerSuffix = `\n_${elapsed}s — still running · ${clock}_`;
  }
  if (params.maxChars !== undefined) {
    const budget = params.maxChars - `${header}\n\n`.length - timerSuffix.length - 2;
    if (budget > 0 && body.length > budget) {
      const tail = body.slice(body.length - budget);
      const nl = tail.indexOf("\n");
      body = `…\n${nl >= 0 ? tail.slice(nl + 1) : tail}`;
    }
  }
  return `${header}\n\n${body}${timerSuffix}`;
}

function stripLineItalics(text: string): string {
  return text
    .split("\n")
    .map((l) => (l.startsWith("_") && l.endsWith("_") && l.length > 1 ? l.slice(1, -1) : l))
    .join("\n");
}

/** Per-stream delta checkpoint: `previousText` is the last cumulative snapshot
 * seen (snapshot→suffix), `lastIncrement` is what it last appended (for replace). */
export type LaneStreamState = { previousText: string; lastIncrement: string };

export function emptyLaneStreamState(): LaneStreamState {
  return { previousText: "", lastIncrement: "" };
}

/** Append the new increment of a streaming text block (reasoning/commentary) to
 * the body. Cumulative snapshots contribute only their new suffix; a `replace`
 * snapshot rewrites the last increment; cross-stream duplicates are folded. */
export function appendLaneDelta(params: {
  body: string;
  state: LaneStreamState;
  text: string;
  delta?: string;
  replace?: boolean;
}): { body: string; state: LaneStreamState } {
  const { previousText, lastIncrement } = params.state;
  let increment: string;
  let nextPreviousText: string;
  if (typeof params.delta === "string") {
    increment = params.delta;
    nextPreviousText =
      params.text.length >= previousText.length ? params.text : previousText + params.delta;
  } else if (previousText !== "" && params.text.startsWith(previousText)) {
    increment = params.text.slice(previousText.length);
    nextPreviousText = params.text;
  } else {
    increment = params.text;
    nextPreviousText = params.text;
  }
  let body = params.body;
  if (params.replace === true && lastIncrement !== "" && body.endsWith(lastIncrement)) {
    body = body.slice(0, body.length - lastIncrement.length);
  } else {
    increment = dropBodyTailOverlap(body, increment);
  }
  if (increment === "") {
    return { body, state: { previousText: nextPreviousText, lastIncrement } };
  }
  return {
    body: body + increment,
    state: { previousText: nextPreviousText, lastIncrement: increment },
  };
}

const LANE_MIN_PARTIAL_OVERLAP = 10;

function dropBodyTailOverlap(body: string, increment: string): string {
  if (!increment) {
    return increment;
  }
  const lines = body.split("\n");
  const proseLines: string[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^\[\d/u.test(lines[i]?.trimStart() ?? "")) {
      break;
    }
    proseLines.unshift(lines[i] ?? "");
  }
  const tail = proseLines.join("\n");
  if (!tail) {
    return increment;
  }
  if (tail.endsWith(increment)) {
    return "";
  }
  if (increment.startsWith(tail)) {
    return increment.slice(tail.length);
  }
  if (increment.length < LANE_MIN_PARTIAL_OVERLAP) {
    return increment;
  }
  const maxK = Math.min(tail.length, increment.length);
  for (let k = maxK; k >= LANE_MIN_PARTIAL_OVERLAP; k -= 1) {
    if (k < increment.length) {
      const before = increment[k - 1] ?? "";
      const after = increment[k] ?? "";
      if (/\w/u.test(before) && /\w/u.test(after)) {
        continue;
      }
    }
    if (tail.endsWith(increment.slice(0, k))) {
      return increment.slice(k);
    }
  }
  return increment;
}

/** Append a timestamped status (tool/event) line, collapsing a repeat of the
 * previous line. */
export function appendStatusLine(params: {
  body: string;
  line: string;
  timestamp: string;
  previousLine?: string;
  maxChars?: number;
}): { body: string; appendedLine: string | undefined } {
  const text = sanitizeLaneLine(params.line, params.maxChars);
  if (!text || text === params.previousLine) {
    return { body: params.body, appendedLine: undefined };
  }
  return {
    body: `${params.body}\n[${params.timestamp}] ${text}\n`,
    appendedLine: text,
  };
}

function normaliseForDedup(text: string): string {
  return stripLineItalics(text).replace(/\s+/gu, " ").trim();
}

/** Remove a final answer that streamed into the body tail (defensive: the
 * engine keeps reply prose out, but redacted-thinking backends can bridge it
 * onto the reasoning stream). Stops at the last status checkpoint. */
export function stripFinalAnswerFromBody(params: { body: string; finalText: string }): string {
  const target = normaliseForDedup(params.finalText);
  if (!target) {
    return params.body;
  }
  const lines = params.body.split("\n");
  for (let start = lines.length - 1; start >= 0; start -= 1) {
    if (/^\[\d/u.test(lines[start]?.trimStart() ?? "")) {
      break;
    }
    const candidate = normaliseForDedup(lines.slice(start).join("\n"));
    if (candidate === target) {
      return lines.slice(0, start).join("\n").trimEnd();
    }
    if (candidate.length > target.length) {
      break;
    }
  }
  return params.body;
}

/** Choose the text for a tool start: name only by default, sanitized args when
 * opted in. */
export function resolveLaneToolLine(params: {
  showArgs: boolean;
  sanitizedLine: string | undefined;
  status?: string;
  toolLabel?: string;
  toolName: string | undefined;
}): string {
  if (params.showArgs && params.sanitizedLine) {
    return params.sanitizedLine;
  }
  const label = params.toolLabel ?? params.toolName;
  const status = params.status ? ` (${params.status})` : "";
  return label ? `tool: ${label}${status}` : "tool running";
}
