// Replays terminal output to authenticate completed TUI PTY evidence.
import * as ansiSequences from "../../packages/terminal-core/src/ansi-sequences.js";
import * as ansi from "../../packages/terminal-core/src/ansi.js";
import {
  PtyTestScreen,
  type PtyRun,
  type PtyTerminalDimensions,
  waitFor,
} from "./tui-pty-test-support.js";

const STALE_CELL_SENTINEL = "\u0000";

function assertEvidence(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

// pi-tui queries cell pixels with CSI 16 t before rendering on image-capable terminals.
const lifecycleCsiBody = /^(?:\?25[hl]|\?2004[hl]|>7u|\?u|c|16t|<u|>4;[02]m)$/u;
const screenMutationCsiBody = /^(?:[02]?J|[02]?K)$/u;

function assertAllowedCsi(screen: PtyTestScreen, value: string, controls: string[] = []) {
  const body = value.startsWith("\x1b[") ? value.slice(2) : "";
  const move = body.match(/^([1-9]\d*)?([ABG])$/u);
  const moveCount = Number(move?.[1] ?? "1");
  const allowed =
    controls.length === 0 &&
    ((move !== null &&
      Number.isSafeInteger(moveCount) &&
      moveCount <= Math.max(screen.cols, screen.rows)) ||
      value === "\x1b[H" ||
      /^(?:0|2|3)?J$/u.test(body) ||
      /^(?:0|2)?K$/u.test(body) ||
      lifecycleCsiBody.test(body) ||
      value === "\x1b[?2026h" ||
      value === "\x1b[?2026l" ||
      /^(?:\d+(?:;\d+)*)?m$/u.test(body));
  assertEvidence(allowed, `unsupported CSI in TUI PTY evidence: ${JSON.stringify(value)}`);
}

function applyScreenCsi(screen: PtyTestScreen, value: string, synchronized: boolean) {
  if (synchronized && lifecycleCsiBody.test(value.slice(2))) {
    throw new Error(`lifecycle CSI inside synchronized frame: ${JSON.stringify(value)}`);
  }
  screen.applyCsi(value, synchronized);
}

function scanOsc(raw: string, bodyStart: number) {
  const candidates: Array<[index: number, length: number]> = [
    [raw.indexOf("\x07", bodyStart), 1],
    [raw.indexOf("\x1b\\", bodyStart), 2],
    [raw.indexOf("\u009c", bodyStart), 1],
  ];
  const terminator = candidates
    .filter(([index]) => index >= 0)
    .toSorted(([left], [right]) => left - right)[0];
  if (!terminator) {
    return undefined;
  }
  const [index, length] = terminator;
  const body = raw.slice(bodyStart, index);
  if (raw[index] === "\u009c" || ansi.sanitizeForLog(body) !== body) {
    throw new Error("unsupported terminal control in TUI PTY OSC evidence");
  }
  return { body, end: index + length };
}

function assertAllowedOsc(body: string) {
  const target = body.startsWith("8;;") ? body.slice(3) : undefined;
  if (
    target === undefined ||
    (target !== "" &&
      (!/^(?:https?:\/\/|mailto:)\S+$/u.test(target) ||
        ansi.sanitizeForLog(target) !== target ||
        !URL.canParse(target)))
  ) {
    throw new Error(`unsupported OSC in TUI PTY evidence: ${JSON.stringify(body)}`);
  }
  return target;
}

function terminalOutputIsComplete(raw: string) {
  const oscStart = Math.max(raw.lastIndexOf("\x1b]"), raw.lastIndexOf("\u009d"));
  if (oscStart >= 0 && !scanOsc(raw, oscStart + (raw[oscStart] === "\x1b" ? 2 : 1))) {
    return false;
  }
  const csiStart = Math.max(raw.lastIndexOf("\x1b["), raw.lastIndexOf("\u009b"));
  const csi = csiStart >= 0 ? ansiSequences.scanAnsiCsiAt(raw, csiStart) : undefined;
  return csi?.ended !== false && !raw.endsWith("\x1b");
}

type TerminalReplay = {
  completedFrame: boolean;
  matchedFrame: boolean;
  osc8Target: string;
  screen: PtyTestScreen;
  synchronized: boolean;
};

function replayTerminalState(
  raw: string,
  dimensions: PtyTerminalDimensions,
  framePredicate?: (screen: PtyTestScreen) => boolean,
): TerminalReplay | undefined {
  const start = "\x1b[?2026h";
  const end = "\x1b[?2026l";
  const screen = new PtyTestScreen(dimensions);
  let completedFrame = false;
  let matchedFrame = false;
  let synchronized = false;
  let osc8Target = "";
  if (!terminalOutputIsComplete(raw)) {
    return undefined;
  }
  for (const segment of ansiSequences.iterateAnsiSegments(raw)) {
    if (segment.kind === "text") {
      // pi-tui expands visible tabs and does not use literal HT/BS for output layout.
      // Captured HT/BS bytes are invalid evidence, not terminal operations to replay.
      if (segment.value.includes("\t") || segment.value.includes("\b")) {
        return undefined;
      }
      if (!synchronized && completedFrame && segment.value) {
        completedFrame = false;
      }
      screen.write(segment.value, synchronized, osc8Target || undefined);
    } else if (segment.controls.length > 0 || !segment.value.startsWith("\x1b")) {
      throw new Error("unsupported terminal sequence in TUI PTY evidence");
    } else if (segment.value === start) {
      assertEvidence(!synchronized, "nested synchronized frame");
      completedFrame = false;
      synchronized = true;
    } else if (segment.value === end) {
      assertEvidence(synchronized, "unmatched synchronized frame end");
      assertEvidence(!osc8Target, "unclosed OSC 8 hyperlink in synchronized frame");
      synchronized = false;
      completedFrame = true;
      matchedFrame ||= framePredicate?.(screen) ?? false;
    } else if (segment.value.startsWith("\x1b]")) {
      const target = assertAllowedOsc(
        segment.value.slice(2, segment.value.endsWith("\x1b\\") ? -2 : -1),
      );
      assertEvidence(synchronized || target === "", "OSC 8 open outside synchronized frame");
      if (!synchronized) {
        continue;
      }
      assertEvidence(
        target === "" || !osc8Target,
        "unbalanced OSC 8 hyperlink in synchronized frame",
      );
      osc8Target = target;
    } else if (segment.value.startsWith("\x1b[")) {
      assertAllowedCsi(screen, segment.value, segment.controls);
      if (!synchronized && completedFrame && screenMutationCsiBody.test(segment.value.slice(2))) {
        completedFrame = false;
      }
      applyScreenCsi(screen, segment.value, synchronized);
    } else {
      throw new Error(`unsupported ESC sequence in TUI PTY evidence: ${segment.value}`);
    }
  }
  return { completedFrame, matchedFrame, osc8Target, screen, synchronized };
}

function parseTerminalState(
  raw: string,
  dimensions: PtyTerminalDimensions,
): PtyTestScreen | undefined {
  const replay = replayTerminalState(raw, dimensions);
  return replay && !replay.synchronized && !replay.osc8Target && replay.completedFrame
    ? replay.screen
    : undefined;
}

function authenticatedRowText(cells: PtyTestScreen["cells"][number]) {
  return cells
    .slice(0, cells.findLastIndex((cell) => cell.authenticated) + 1)
    .map((cell) => (cell.text === "" || cell.authenticated ? cell.text : STALE_CELL_SENTINEL))
    .join("")
    .trimEnd();
}

export function synchronizedFrameRows(raw: string, dimensions: PtyTerminalDimensions): string[][] {
  const screen = parseTerminalState(raw, dimensions);
  if (!screen) {
    return [];
  }
  const rows = screen.cells.map(authenticatedRowText);
  while (rows.length > 1 && rows.at(-1) === "") {
    rows.pop();
  }
  return [rows];
}

/** Links on the authenticated current screen, retaining row boundaries and erasures. */
export function synchronizedFrameLinks(raw: string, dimensions: PtyTerminalDimensions) {
  const screen = parseTerminalState(raw, dimensions);
  const links: Array<{ row: number; target: string; text: string }> = [];
  for (const [row, cells] of (screen?.cells ?? []).entries()) {
    let span: (typeof links)[number] | undefined;
    for (const cell of cells) {
      if (!cell.authenticated || !cell.linkTarget) {
        span = undefined;
      } else if (span?.target === cell.linkTarget) {
        span.text += cell.text;
      } else {
        span = { row, target: cell.linkTarget, text: cell.text };
        links.push(span);
      }
    }
  }
  return links;
}

export async function waitForSynchronizedFrameRows(
  run: PtyRun,
  predicate: (rows: string[]) => boolean,
  timeoutMs: number,
) {
  return await waitFor({
    timeoutMs,
    read: () => {
      const rows = synchronizedFrameRows(run.output(), run).at(0);
      return rows && predicate(rows) ? rows : null;
    },
    onTimeout: () => new Error(`expected completed synchronized frame\n${run.output()}`),
  });
}

function screenHasRow(screen: PtyTestScreen, predicate: (row: string) => boolean) {
  return screen.cells.some((cells) => predicate(authenticatedRowText(cells)));
}

function latestFrameHasRow(
  raw: string,
  dimensions: PtyTerminalDimensions,
  predicate: (row: string) => boolean,
) {
  const screen = parseTerminalState(raw, dimensions);
  return screen ? screenHasRow(screen, predicate) : false;
}

function terminalAttackRowMatches(markers: string[], expectedText: string, row: string) {
  return markers.every((marker) => row.includes(marker)) && row.includes(expectedText);
}

export function hasSynchronizedFrameRow(
  raw: string,
  markers: string[],
  expectedText: string,
  dimensions: PtyTerminalDimensions,
) {
  return latestFrameHasRow(raw, dimensions, (row) =>
    terminalAttackRowMatches(markers, expectedText, row),
  );
}

export function hasHistoricalSynchronizedFrameRow(
  raw: string,
  markers: string[],
  expectedText: string,
  dimensions: PtyTerminalDimensions,
) {
  const replay = replayTerminalState(raw, dimensions, (screen) =>
    screenHasRow(screen, (row) => terminalAttackRowMatches(markers, expectedText, row)),
  );
  return replay !== undefined && !replay.synchronized && !replay.osc8Target && replay.matchedFrame;
}
