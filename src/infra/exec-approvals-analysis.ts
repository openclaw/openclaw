import { splitShellArgs } from "../utils/shell-argv.js";
import {
  resolveCommandResolutionFromArgv,
  type CommandResolution,
} from "./exec-command-resolution.js";

export {
  DEFAULT_SAFE_BINS,
  matchAllowlist,
  parseExecArgvToken,
  resolveAllowlistCandidatePath,
  resolveCommandResolution,
  resolveCommandResolutionFromArgv,
  type CommandResolution,
  type ExecArgvToken,
} from "./exec-command-resolution.js";

export type ExecCommandSegment = {
  raw: string;
  argv: string[];
  resolution: CommandResolution | null;
};

export type ExecCommandAnalysis = {
  ok: boolean;
  reason?: string;
  segments: ExecCommandSegment[];
  chains?: ExecCommandSegment[][]; // Segments grouped by chain operator (&&, ||, ;)
};

export type ShellChainOperator = "&&" | "||" | ";";

export type ShellChainPart = {
  part: string;
  opToNext: ShellChainOperator | null;
};

const DISALLOWED_PIPELINE_TOKENS = new Set([">", "<", "`", "\n", "\r", "(", ")"]);
const DOUBLE_QUOTE_ESCAPES = new Set(["\\", '"', "$", "`"]);
const WINDOWS_UNSUPPORTED_TOKENS = new Set([
  "&",
  "|",
  "<",
  ">",
  "^",
  "(",
  ")",
  "%",
  "!",
  "\n",
  "\r",
]);

function isDoubleQuoteEscape(next: string | undefined): next is string {
  return Boolean(next && DOUBLE_QUOTE_ESCAPES.has(next));
}

function isEscapedLineContinuation(next: string | undefined): next is string {
  return next === "\n" || next === "\r";
}

function splitShellPipeline(command: string): { ok: boolean; reason?: string; segments: string[] } {
  type HeredocSpec = {
    delimiter: string;
    stripTabs: boolean;
    quoted: boolean;
  };

  const parseHeredocDelimiter = (
    source: string,
    start: number,
  ): { delimiter: string; end: number; quoted: boolean } | null => {
    let i = start;
    while (i < source.length && (source[i] === " " || source[i] === "\t")) {
      i += 1;
    }
    if (i >= source.length) {
      return null;
    }

    const first = source[i];
    if (first === "'" || first === '"') {
      const quote = first;
      i += 1;
      let delimiter = "";
      while (i < source.length) {
        const ch = source[i];
        if (ch === "\n" || ch === "\r") {
          return null;
        }
        if (quote === '"' && ch === "\\" && i + 1 < source.length) {
          delimiter += source[i + 1];
          i += 2;
          continue;
        }
        if (ch === quote) {
          return { delimiter, end: i + 1, quoted: true };
        }
        delimiter += ch;
        i += 1;
      }
      return null;
    }

    let delimiter = "";
    while (i < source.length) {
      const ch = source[i];
      if (/\s/.test(ch) || ch === "|" || ch === "&" || ch === ";" || ch === "<" || ch === ">") {
        break;
      }
      delimiter += ch;
      i += 1;
    }
    if (!delimiter) {
      return null;
    }
    return { delimiter, end: i, quoted: false };
  };

  const segments: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let emptySegment = false;
  const pendingHeredocs: HeredocSpec[] = [];
  let inHeredocBody = false;
  let heredocLine = "";

  const pushPart = () => {
    const trimmed = buf.trim();
    if (trimmed) {
      segments.push(trimmed);
    }
    buf = "";
  };

  const isEscapedInHeredocLine = (line: string, index: number): boolean => {
    let slashes = 0;
    for (let i = index - 1; i >= 0 && line[i] === "\\"; i -= 1) {
      slashes += 1;
    }
    return slashes % 2 === 1;
  };

  const hasUnquotedHeredocExpansionToken = (line: string): boolean => {
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === "`" && !isEscapedInHeredocLine(line, i)) {
        return true;
      }
      if (ch === "$" && !isEscapedInHeredocLine(line, i)) {
        const next = line[i + 1];
        if (next === "(" || next === "{") {
          return true;
        }
      }
    }
    return false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];

    if (inHeredocBody) {
      if (ch === "\n" || ch === "\r") {
        const current = pendingHeredocs[0];
        if (current) {
          const line = current.stripTabs ? heredocLine.replace(/^\t+/, "") : heredocLine;
          if (line === current.delimiter) {
            pendingHeredocs.shift();
          } else if (!current.quoted && hasUnquotedHeredocExpansionToken(heredocLine)) {
            return { ok: false, reason: "command substitution in unquoted heredoc", segments: [] };
          }
        }
        heredocLine = "";
        if (pendingHeredocs.length === 0) {
          inHeredocBody = false;
        }
        if (ch === "\r" && next === "\n") {
          i += 1;
        }
      } else {
        heredocLine += ch;
      }
      continue;
    }

    if (escaped) {
      buf += ch;
      escaped = false;
      emptySegment = false;
      continue;
    }
    if (!inSingle && !inDouble && ch === "\\") {
      escaped = true;
      buf += ch;
      emptySegment = false;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      buf += ch;
      emptySegment = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && isEscapedLineContinuation(next)) {
        return { ok: false, reason: "unsupported shell token: newline", segments: [] };
      }
      if (ch === "\\" && isDoubleQuoteEscape(next)) {
        buf += ch;
        buf += next;
        i += 1;
        emptySegment = false;
        continue;
      }
      if (ch === "$" && next === "(") {
        return { ok: false, reason: "unsupported shell token: $()", segments: [] };
      }
      if (ch === "`") {
        return { ok: false, reason: "unsupported shell token: `", segments: [] };
      }
      if (ch === "\n" || ch === "\r") {
        return { ok: false, reason: "unsupported shell token: newline", segments: [] };
      }
      if (ch === '"') {
        inDouble = false;
      }
      buf += ch;
      emptySegment = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      buf += ch;
      emptySegment = false;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      buf += ch;
      emptySegment = false;
      continue;
    }

    if ((ch === "\n" || ch === "\r") && pendingHeredocs.length > 0) {
      inHeredocBody = true;
      heredocLine = "";
      if (ch === "\r" && next === "\n") {
        i += 1;
      }
      continue;
    }

    if (ch === "|" && next === "|") {
      return { ok: false, reason: "unsupported shell token: ||", segments: [] };
    }
    if (ch === "|" && next === "&") {
      return { ok: false, reason: "unsupported shell token: |&", segments: [] };
    }
    if (ch === "|") {
      emptySegment = true;
      pushPart();
      continue;
    }
    if (ch === "&" || ch === ";") {
      return { ok: false, reason: `unsupported shell token: ${ch}`, segments: [] };
    }
    if (ch === "<" && next === "<") {
      buf += "<<";
      emptySegment = false;
      i += 1;

      let scanIndex = i + 1;
      let stripTabs = false;
      if (command[scanIndex] === "-") {
        stripTabs = true;
        buf += "-";
        scanIndex += 1;
      }

      const parsed = parseHeredocDelimiter(command, scanIndex);
      if (parsed) {
        pendingHeredocs.push({ delimiter: parsed.delimiter, stripTabs, quoted: parsed.quoted });
        buf += command.slice(scanIndex, parsed.end);
        i = parsed.end - 1;
      }
      continue;
    }
    if (DISALLOWED_PIPELINE_TOKENS.has(ch)) {
      return { ok: false, reason: `unsupported shell token: ${ch}`, segments: [] };
    }
    if (ch === "$" && next === "(") {
      return { ok: false, reason: "unsupported shell token: $()", segments: [] };
    }
    buf += ch;
    emptySegment = false;
  }

  if (inHeredocBody && pendingHeredocs.length > 0) {
    const current = pendingHeredocs[0];
    const line = current.stripTabs ? heredocLine.replace(/^\t+/, "") : heredocLine;
    if (line === current.delimiter) {
      pendingHeredocs.shift();
      if (pendingHeredocs.length === 0) {
        inHeredocBody = false;
      }
    }
  }

  if (pendingHeredocs.length > 0 || inHeredocBody) {
    return { ok: false, reason: "unterminated heredoc", segments: [] };
  }

  if (escaped || inSingle || inDouble) {
    return { ok: false, reason: "unterminated shell quote/escape", segments: [] };
  }

  pushPart();
  if (emptySegment || segments.length === 0) {
    return {
      ok: false,
      reason: segments.length === 0 ? "empty command" : "empty pipeline segment",
      segments: [],
    };
  }
  return { ok: true, segments };
}

function findWindowsUnsupportedToken(command: string): string | null {
  for (const ch of command) {
    if (WINDOWS_UNSUPPORTED_TOKENS.has(ch)) {
      if (ch === "\n" || ch === "\r") {
        return "newline";
      }
      return ch;
    }
  }
  return null;
}

function tokenizeWindowsSegment(segment: string): string[] | null {
  const tokens: string[] = [];
  let buf = "";
  let inDouble = false;

  const pushToken = () => {
    if (buf.length > 0) {
      tokens.push(buf);
      buf = "";
    }
  };

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inDouble && /\s/.test(ch)) {
      pushToken();
      continue;
    }
    buf += ch;
  }

  if (inDouble) {
    return null;
  }
  pushToken();
  return tokens.length > 0 ? tokens : null;
}

function analyzeWindowsShellCommand(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): ExecCommandAnalysis {
  const unsupported = findWindowsUnsupportedToken(params.command);
  if (unsupported) {
    return {
      ok: false,
      reason: `unsupported windows shell token: ${unsupported}`,
      segments: [],
    };
  }
  const argv = tokenizeWindowsSegment(params.command);
  if (!argv || argv.length === 0) {
    return { ok: false, reason: "unable to parse windows command", segments: [] };
  }
  return {
    ok: true,
    segments: [
      {
        raw: params.command,
        argv,
        resolution: resolveCommandResolutionFromArgv(argv, params.cwd, params.env),
      },
    ],
  };
}

export function isWindowsPlatform(platform?: string | null): boolean {
  const normalized = String(platform ?? "")
    .trim()
    .toLowerCase();
  return normalized.startsWith("win");
}

function parseSegmentsFromParts(
  parts: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): ExecCommandSegment[] | null {
  const segments: ExecCommandSegment[] = [];
  for (const raw of parts) {
    const argv = splitShellArgs(raw);
    if (!argv || argv.length === 0) {
      return null;
    }
    segments.push({
      raw,
      argv,
      resolution: resolveCommandResolutionFromArgv(argv, cwd, env),
    });
  }
  return segments;
}

/**
 * Splits a command string by chain operators (&&, ||, ;) while preserving the operators.
 * Returns null when no chain is present or when the chain is malformed.
 */
export function splitCommandChainWithOperators(command: string): ShellChainPart[] | null {
  const parts: ShellChainPart[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let foundChain = false;
  let invalidChain = false;

  const pushPart = (opToNext: ShellChainOperator | null) => {
    const trimmed = buf.trim();
    buf = "";
    if (!trimmed) {
      return false;
    }
    parts.push({ part: trimmed, opToNext });
    return true;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (!inSingle && !inDouble && ch === "\\") {
      escaped = true;
      buf += ch;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      }
      buf += ch;
      continue;
    }
    if (inDouble) {
      if (ch === "\\" && isEscapedLineContinuation(next)) {
        invalidChain = true;
        break;
      }
      if (ch === "\\" && isDoubleQuoteEscape(next)) {
        buf += ch;
        buf += next;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      }
      buf += ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      buf += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      buf += ch;
      continue;
    }

    if (ch === "&" && next === "&") {
      if (!pushPart("&&")) {
        invalidChain = true;
      }
      i += 1;
      foundChain = true;
      continue;
    }
    if (ch === "|" && next === "|") {
      if (!pushPart("||")) {
        invalidChain = true;
      }
      i += 1;
      foundChain = true;
      continue;
    }
    if (ch === ";") {
      if (!pushPart(";")) {
        invalidChain = true;
      }
      foundChain = true;
      continue;
    }

    buf += ch;
  }

  if (!foundChain) {
    return null;
  }
  const trimmed = buf.trim();
  if (!trimmed) {
    return null;
  }
  parts.push({ part: trimmed, opToNext: null });
  if (invalidChain || parts.length === 0) {
    return null;
  }
  return parts;
}

function shellEscapeSingleArg(value: string): string {
  // Shell-safe across sh/bash/zsh: single-quote everything, escape embedded single quotes.
  // Example: foo'bar -> 'foo'"'"'bar'
  const singleQuoteEscape = `'"'"'`;
  return `'${value.replace(/'/g, singleQuoteEscape)}'`;
}

type ShellSegmentRenderResult = { ok: true; rendered: string } | { ok: false; reason: string };

function rebuildShellCommandFromSource(params: {
  command: string;
  platform?: string | null;
  renderSegment: (rawSegment: string, segmentIndex: number) => ShellSegmentRenderResult;
}): { ok: boolean; command?: string; reason?: string; segmentCount?: number } {
  const platform = params.platform ?? null;
  if (isWindowsPlatform(platform)) {
    return { ok: false, reason: "unsupported platform" };
  }
  const source = params.command.trim();
  if (!source) {
    return { ok: false, reason: "empty command" };
  }

  const chain = splitCommandChainWithOperators(source);
  const chainParts: ShellChainPart[] = chain ?? [{ part: source, opToNext: null }];
  let segmentCount = 0;
  let out = "";

  for (const part of chainParts) {
    const pipelineSplit = splitShellPipeline(part.part);
    if (!pipelineSplit.ok) {
      return { ok: false, reason: pipelineSplit.reason ?? "unable to parse pipeline" };
    }
    const renderedSegments: string[] = [];
    for (const segmentRaw of pipelineSplit.segments) {
      const rendered = params.renderSegment(segmentRaw, segmentCount);
      if (!rendered.ok) {
        return { ok: false, reason: rendered.reason };
      }
      renderedSegments.push(rendered.rendered);
      segmentCount += 1;
    }
    out += renderedSegments.join(" | ");
    if (part.opToNext) {
      out += ` ${part.opToNext} `;
    }
  }

  return { ok: true, command: out, segmentCount };
}

/**
 * Builds a shell command string that preserves pipes/chaining, but forces *arguments* to be
 * literal (no globbing, no env-var expansion) by single-quoting every argv token.
 *
 * Used to make "safe bins" actually stdin-only even though execution happens via `shell -c`.
 */
export function buildSafeShellCommand(params: { command: string; platform?: string | null }): {
  ok: boolean;
  command?: string;
  reason?: string;
} {
  const rebuilt = rebuildShellCommandFromSource({
    command: params.command,
    platform: params.platform,
    renderSegment: (segmentRaw) => {
      const argv = splitShellArgs(segmentRaw);
      if (!argv || argv.length === 0) {
        return { ok: false, reason: "unable to parse shell segment" };
      }
      return { ok: true, rendered: argv.map((token) => shellEscapeSingleArg(token)).join(" ") };
    },
  });
  if (!rebuilt.ok) {
    return { ok: false, reason: rebuilt.reason };
  }
  return { ok: true, command: rebuilt.command };
}

function renderQuotedArgv(argv: string[]): string {
  return argv.map((token) => shellEscapeSingleArg(token)).join(" ");
}

function resolvePlannedSegmentArgv(segment: ExecCommandSegment): string[] | null {
  if (segment.resolution?.policyBlocked === true) {
    return null;
  }
  const baseArgv =
    segment.resolution?.effectiveArgv && segment.resolution.effectiveArgv.length > 0
      ? segment.resolution.effectiveArgv
      : segment.argv;
  if (baseArgv.length === 0) {
    return null;
  }
  const argv = [...baseArgv];
  const resolvedExecutable = segment.resolution?.resolvedPath?.trim() ?? "";
  if (resolvedExecutable) {
    argv[0] = resolvedExecutable;
  }
  return argv;
}

function renderSafeBinSegmentArgv(segment: ExecCommandSegment): string | null {
  const argv = resolvePlannedSegmentArgv(segment);
  if (!argv || argv.length === 0) {
    return null;
  }
  return renderQuotedArgv(argv);
}

/**
 * Rebuilds a shell command and selectively single-quotes argv tokens for segments that
 * must be treated as literal (safeBins hardening) while preserving the rest of the
 * shell syntax (pipes + chaining).
 */
export function buildSafeBinsShellCommand(params: {
  command: string;
  segments: ExecCommandSegment[];
  segmentSatisfiedBy: ("allowlist" | "safeBins" | "skills" | null)[];
  platform?: string | null;
}): { ok: boolean; command?: string; reason?: string } {
  if (params.segments.length !== params.segmentSatisfiedBy.length) {
    return { ok: false, reason: "segment metadata mismatch" };
  }
  const rebuilt = rebuildShellCommandFromSource({
    command: params.command,
    platform: params.platform,
    renderSegment: (raw, segmentIndex) => {
      const seg = params.segments[segmentIndex];
      const by = params.segmentSatisfiedBy[segmentIndex];
      if (!seg || by === undefined) {
        return { ok: false, reason: "segment mapping failed" };
      }
      const needsLiteral = by === "safeBins";
      if (!needsLiteral) {
        return { ok: true, rendered: raw.trim() };
      }
      const rendered = renderSafeBinSegmentArgv(seg);
      if (!rendered) {
        return { ok: false, reason: "segment execution plan unavailable" };
      }
      return { ok: true, rendered };
    },
  });
  if (!rebuilt.ok) {
    return { ok: false, reason: rebuilt.reason };
  }
  if (rebuilt.segmentCount !== params.segments.length) {
    return { ok: false, reason: "segment count mismatch" };
  }
  return { ok: true, command: rebuilt.command };
}

export function buildEnforcedShellCommand(params: {
  command: string;
  segments: ExecCommandSegment[];
  platform?: string | null;
}): { ok: boolean; command?: string; reason?: string } {
  const rebuilt = rebuildShellCommandFromSource({
    command: params.command,
    platform: params.platform,
    renderSegment: (_raw, segmentIndex) => {
      const seg = params.segments[segmentIndex];
      if (!seg) {
        return { ok: false, reason: "segment mapping failed" };
      }
      const argv = resolvePlannedSegmentArgv(seg);
      if (!argv) {
        return { ok: false, reason: "segment execution plan unavailable" };
      }
      return { ok: true, rendered: renderQuotedArgv(argv) };
    },
  });
  if (!rebuilt.ok) {
    return { ok: false, reason: rebuilt.reason };
  }
  if (rebuilt.segmentCount !== params.segments.length) {
    return { ok: false, reason: "segment count mismatch" };
  }
  return { ok: true, command: rebuilt.command };
}

/**
 * Splits a command string by chain operators (&&, ||, ;) while respecting quotes.
 * Returns null when no chain is present or when the chain is malformed.
 */
export function splitCommandChain(command: string): string[] | null {
  const parts = splitCommandChainWithOperators(command);
  if (!parts) {
    return null;
  }
  return parts.map((p) => p.part);
}

export function analyzeShellCommand(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: string | null;
}): ExecCommandAnalysis {
  if (isWindowsPlatform(params.platform)) {
    return analyzeWindowsShellCommand(params);
  }
  // First try splitting by chain operators (&&, ||, ;)
  const chainParts = splitCommandChain(params.command);
  if (chainParts) {
    const chains: ExecCommandSegment[][] = [];
    const allSegments: ExecCommandSegment[] = [];

    for (const part of chainParts) {
      const pipelineSplit = splitShellPipeline(part);
      if (!pipelineSplit.ok) {
        return { ok: false, reason: pipelineSplit.reason, segments: [] };
      }
      const segments = parseSegmentsFromParts(pipelineSplit.segments, params.cwd, params.env);
      if (!segments) {
        return { ok: false, reason: "unable to parse shell segment", segments: [] };
      }
      chains.push(segments);
      allSegments.push(...segments);
    }

    return { ok: true, segments: allSegments, chains };
  }

  // No chain operators, parse as simple pipeline
  const split = splitShellPipeline(params.command);
  if (!split.ok) {
    return { ok: false, reason: split.reason, segments: [] };
  }
  const segments = parseSegmentsFromParts(split.segments, params.cwd, params.env);
  if (!segments) {
    return { ok: false, reason: "unable to parse shell segment", segments: [] };
  }
  return { ok: true, segments };
}

export function analyzeArgvCommand(params: {
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): ExecCommandAnalysis {
  const argv = params.argv.filter((entry) => entry.trim().length > 0);
  if (argv.length === 0) {
    return { ok: false, reason: "empty argv", segments: [] };
  }
  return {
    ok: true,
    segments: [
      {
        raw: argv.join(" "),
        argv,
        resolution: resolveCommandResolutionFromArgv(argv, params.cwd, params.env),
      },
    ],
  };
}
