export type MarkdownChunkOptions = {
  maxChars: number;
};

type OpenFence = {
  hasInfoString: boolean;
  indent: string;
  markerChar: string;
  markerLen: number;
  openLine: string;
};

type LocalFenceSpan = OpenFence & {
  closed: boolean;
  start: number;
  end: number;
};

type FenceState = {
  leadingOpenFence: LocalFenceSpan | null;
  spans: LocalFenceSpan[];
  trailingOpenFence: LocalFenceSpan | null;
};

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

function parseFenceLine(line: string): OpenFence | null {
  const match = line.match(FENCE_RE);
  if (!match) {
    return null;
  }
  const indent = match[1] ?? "";
  const marker = match[2] ?? "";
  const suffix = match[3] ?? "";
  return {
    hasInfoString: suffix.trim().length > 0,
    indent,
    markerChar: marker[0] ?? "`",
    markerLen: marker.length,
    openLine: line,
  };
}

function closeFenceLine(openFence: OpenFence) {
  return `${openFence.indent}${openFence.markerChar.repeat(openFence.markerLen)}`;
}

function closeFenceIfNeeded(text: string, openFence: OpenFence | null) {
  if (!openFence) {
    return text;
  }
  const closeLine = closeFenceLine(openFence);
  if (!text) {
    return closeLine;
  }
  if (!text.endsWith("\n")) {
    return `${text}\n${closeLine}`;
  }
  return `${text}${closeLine}`;
}

function parseFenceSpans(text: string): LocalFenceSpan[] {
  const spans: LocalFenceSpan[] = [];
  let openFence: LocalFenceSpan | null = null;
  let offset = 0;
  while (offset <= text.length) {
    const nextNewline = text.indexOf("\n", offset);
    const lineEnd = nextNewline === -1 ? text.length : nextNewline;
    const line = text.slice(offset, lineEnd);
    const fence = parseFenceLine(line);
    if (fence) {
      if (!openFence) {
        openFence = {
          closed: false,
          ...fence,
          start: offset,
          end: text.length,
        };
      } else if (
        openFence.markerChar === fence.markerChar &&
        fence.markerLen >= openFence.markerLen
      ) {
        openFence.end = lineEnd;
        openFence.closed = true;
        spans.push(openFence);
        openFence = null;
      }
    }
    if (nextNewline === -1) {
      break;
    }
    offset = nextNewline + 1;
  }
  if (openFence) {
    spans.push(openFence);
  }
  return spans;
}

function findFenceSpanAt(spans: LocalFenceSpan[], index: number): LocalFenceSpan | null {
  for (const span of spans) {
    if (index > span.start && index < span.end) {
      return span;
    }
  }
  return null;
}

function findTrailingOpenFence(spans: LocalFenceSpan[]): LocalFenceSpan | null {
  const last = spans.at(-1);
  if (!last || last.closed) {
    return null;
  }
  return last;
}

function getFenceState(text: string): FenceState {
  const spans = parseFenceSpans(text);
  const trailingOpenFence = findTrailingOpenFence(spans);
  return {
    spans,
    trailingOpenFence,
    leadingOpenFence: trailingOpenFence?.start === 0 ? trailingOpenFence : null,
  };
}

function renderChunkWithFence(text: string, openFence: OpenFence | null): string {
  return closeFenceIfNeeded(text, openFence);
}

function getStandaloneChunkFence(text: string, fenceState: FenceState): LocalFenceSpan | null {
  if (fenceState.leadingOpenFence) {
    return fenceState.leadingOpenFence;
  }
  const trailing = fenceState.trailingOpenFence;
  if (!trailing) {
    return null;
  }
  if (trailing.hasInfoString || trailing.start === 0) {
    return trailing;
  }
  const trailingBody = text.slice(trailing.start + trailing.openLine.length);
  return trailingBody.length > 0 ? trailing : null;
}

function isSafeFenceBreak(spans: LocalFenceSpan[], index: number): boolean {
  return findFenceSpanAt(spans, index) === null;
}

function findWhitespaceBreak(text: string, maxChars: number, spans: LocalFenceSpan[]): number {
  for (let i = Math.min(maxChars - 1, text.length - 1); i >= 0; i--) {
    const char = text[i];
    if (!char || !/\s/.test(char)) {
      continue;
    }
    if (!isSafeFenceBreak(spans, i)) {
      continue;
    }
    return i + 1;
  }
  return -1;
}

function findPreferredBreak(text: string, maxChars: number, spans: LocalFenceSpan[]): number {
  const paragraphIdx = text.lastIndexOf("\n\n", maxChars);
  if (paragraphIdx > 0 && paragraphIdx + 2 <= maxChars && isSafeFenceBreak(spans, paragraphIdx)) {
    return paragraphIdx + 2;
  }

  const newlineIdx = text.lastIndexOf("\n", maxChars);
  if (newlineIdx > 0 && newlineIdx + 1 <= maxChars && isSafeFenceBreak(spans, newlineIdx)) {
    return newlineIdx + 1;
  }

  const whitespaceIdx = findWhitespaceBreak(text, maxChars, spans);
  if (whitespaceIdx > 0) {
    return whitespaceIdx;
  }

  return Math.min(maxChars, text.length);
}

function isInsideFenceOpener(span: LocalFenceSpan, index: number): boolean {
  return index <= span.start + span.openLine.length;
}

function reopenFenceTail(openFence: OpenFence, tail: string): string {
  return `${openFence.openLine}${tail.startsWith("\n") ? "" : "\n"}${tail}`;
}

function renderedChunkExceedsLimit(text: string, maxChars: number, openFence: OpenFence | null) {
  return text.length > maxChars || renderChunkWithFence(text, openFence).length > maxChars;
}

function resolveFenceAtBreak(
  spans: LocalFenceSpan[],
  breakIdx: number,
  remainingLength: number,
  chunkFence: LocalFenceSpan | null,
) {
  return findFenceSpanAt(spans, breakIdx) ?? (breakIdx === remainingLength ? chunkFence : null);
}

function chooseBreakForRemaining(remaining: string, maxChars: number, fenceState: FenceState) {
  const chunkFence = getStandaloneChunkFence(remaining, fenceState);
  let effectiveMaxChars = maxChars;
  let breakIdx = findPreferredBreak(remaining, effectiveMaxChars, fenceState.spans);
  let fenceAtBreak = resolveFenceAtBreak(fenceState.spans, breakIdx, remaining.length, chunkFence);

  while (fenceAtBreak) {
    const chunk = remaining.slice(0, breakIdx);
    const closeLine = closeFenceLine(fenceAtBreak);
    const reserveChars = closeLine.length + (chunk.endsWith("\n") ? 0 : 1);
    if (breakIdx + reserveChars <= maxChars) {
      break;
    }
    const nextEffectiveMaxChars = Math.max(1, maxChars - reserveChars);
    if (nextEffectiveMaxChars >= effectiveMaxChars) {
      break;
    }
    effectiveMaxChars = nextEffectiveMaxChars;
    breakIdx = findPreferredBreak(remaining, effectiveMaxChars, fenceState.spans);
    fenceAtBreak = resolveFenceAtBreak(fenceState.spans, breakIdx, remaining.length, chunkFence);
  }

  return { breakIdx, fenceAtBreak };
}

function splitRemainingChunk(
  remaining: string,
  breakIdx: number,
  fenceAtBreak: LocalFenceSpan | null,
  opts: { maxChars: number; trailingOpenFence: LocalFenceSpan | null },
) {
  let safeBreakIdx = Math.max(1, Math.min(breakIdx, remaining.length));
  let carryFence =
    fenceAtBreak && !isInsideFenceOpener(fenceAtBreak, safeBreakIdx) ? fenceAtBreak : null;
  let tail = remaining.slice(safeBreakIdx);
  let nextRemaining = tail;
  if (carryFence) {
    let reopened = reopenFenceTail(carryFence, tail);
    if (
      reopened.length >= remaining.length &&
      safeBreakIdx < remaining.length &&
      renderChunkWithFence(remaining.slice(0, safeBreakIdx + 1), carryFence).length <= opts.maxChars
    ) {
      safeBreakIdx += 1;
      tail = remaining.slice(safeBreakIdx);
      reopened = reopenFenceTail(carryFence, tail);
    }
    if (reopened.length < remaining.length) {
      nextRemaining = reopened;
    } else if (
      opts.trailingOpenFence &&
      renderChunkWithFence(remaining.slice(0, safeBreakIdx), carryFence).length <= opts.maxChars
    ) {
      nextRemaining = tail;
    } else {
      carryFence = null;
    }
  }
  if (nextRemaining.length >= remaining.length) {
    return { breakIdx: safeBreakIdx, carryFence: null, nextRemaining: tail };
  }
  return { breakIdx: safeBreakIdx, carryFence, nextRemaining };
}

export function chunkMarkdownWithBalancedFences(
  text: string,
  opts: MarkdownChunkOptions,
): string[] {
  const maxChars = Math.max(1, Math.floor(opts.maxChars));
  const body = text ?? "";
  if (!body) {
    return [];
  }

  const bodyFenceState = getFenceState(body);
  const renderedBody = renderChunkWithFence(body, getStandaloneChunkFence(body, bodyFenceState));
  if (renderedBody.length <= maxChars) {
    return [renderedBody];
  }

  const chunks: string[] = [];
  let remaining = body;

  while (true) {
    const fenceState = getFenceState(remaining);
    if (
      !renderedChunkExceedsLimit(
        remaining,
        maxChars,
        getStandaloneChunkFence(remaining, fenceState),
      )
    ) {
      break;
    }
    const { breakIdx, fenceAtBreak } = chooseBreakForRemaining(remaining, maxChars, fenceState);
    const { carryFence, nextRemaining } = splitRemainingChunk(remaining, breakIdx, fenceAtBreak, {
      maxChars,
      trailingOpenFence: fenceState.trailingOpenFence,
    });
    const chunk = remaining.slice(0, breakIdx);
    if (chunk.length > 0) {
      chunks.push(renderChunkWithFence(chunk, carryFence));
    }
    remaining = nextRemaining;
  }

  if (remaining.length) {
    const fenceState = getFenceState(remaining);
    chunks.push(renderChunkWithFence(remaining, getStandaloneChunkFence(remaining, fenceState)));
  }

  return chunks;
}
