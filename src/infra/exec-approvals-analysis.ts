import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExecAllowlistEntry } from "./exec-approvals.js";

export const DEFAULT_SAFE_BINS = ["jq", "grep", "cut", "sort", "uniq", "head", "tail", "tr", "wc"];

function expandHome(value: string): string {
  if (!value) {
    return value;
  }
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export type CommandResolution = {
  rawExecutable: string;
  resolvedPath?: string;
  executableName: string;
};

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform !== "win32") {
      fs.accessSync(filePath, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function parseFirstToken(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }
  const first = trimmed[0];
  if (first === '"' || first === "'") {
    const end = trimmed.indexOf(first, 1);
    if (end > 1) {
      return trimmed.slice(1, end);
    }
    return trimmed.slice(1);
  }
  const match = /^[^\s]+/.exec(trimmed);
  return match ? match[0] : null;
}

function resolveExecutablePath(rawExecutable: string, cwd?: string, env?: NodeJS.ProcessEnv) {
  const expanded = rawExecutable.startsWith("~") ? expandHome(rawExecutable) : rawExecutable;
  if (expanded.includes("/") || expanded.includes("\\")) {
    if (path.isAbsolute(expanded)) {
      return isExecutableFile(expanded) ? expanded : undefined;
    }
    const base = cwd && cwd.trim() ? cwd.trim() : process.cwd();
    const candidate = path.resolve(base, expanded);
    return isExecutableFile(candidate) ? candidate : undefined;
  }
  const envPath = env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? "";
  const entries = envPath.split(path.delimiter).filter(Boolean);
  const hasExtension = process.platform === "win32" && path.extname(expanded).length > 0;
  const extensions =
    process.platform === "win32"
      ? hasExtension
        ? [""]
        : (
            env?.PATHEXT ??
            env?.Pathext ??
            process.env.PATHEXT ??
            process.env.Pathext ??
            ".EXE;.CMD;.BAT;.COM"
          )
            .split(";")
            .map((ext) => ext.toLowerCase())
      : [""];
  for (const entry of entries) {
    for (const ext of extensions) {
      const candidate = path.join(entry, expanded + ext);
      if (isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export function resolveCommandResolution(
  command: string,
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): CommandResolution | null {
  const rawExecutable = parseFirstToken(command);
  if (!rawExecutable) {
    return null;
  }
  const resolvedPath = resolveExecutablePath(rawExecutable, cwd, env);
  const executableName = resolvedPath ? path.basename(resolvedPath) : rawExecutable;
  return { rawExecutable, resolvedPath, executableName };
}

export function resolveCommandResolutionFromArgv(
  argv: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): CommandResolution | null {
  const rawExecutable = argv[0]?.trim();
  if (!rawExecutable) {
    return null;
  }
  const resolvedPath = resolveExecutablePath(rawExecutable, cwd, env);
  const executableName = resolvedPath ? path.basename(resolvedPath) : rawExecutable;
  return { rawExecutable, resolvedPath, executableName };
}

function normalizeMatchTarget(value: string): string {
  if (process.platform === "win32") {
    const stripped = value.replace(/^\\\\[?.]\\/, "");
    return stripped.replace(/\\/g, "/").toLowerCase();
  }
  return value.replace(/\\\\/g, "/").toLowerCase();
}

function tryRealpath(value: string): string | null {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

function globToRegExp(pattern: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      const next = pattern[i + 1];
      if (next === "*") {
        regex += ".*";
        i += 2;
        continue;
      }
      regex += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      regex += ".";
      i += 1;
      continue;
    }
    regex += ch.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&");
    i += 1;
  }
  regex += "$";
  return new RegExp(regex, "i");
}

function matchesPattern(pattern: string, target: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }
  const expanded = trimmed.startsWith("~") ? expandHome(trimmed) : trimmed;
  const hasWildcard = /[*?]/.test(expanded);
  let normalizedPattern = expanded;
  let normalizedTarget = target;
  if (process.platform === "win32" && !hasWildcard) {
    normalizedPattern = tryRealpath(expanded) ?? expanded;
    normalizedTarget = tryRealpath(target) ?? target;
  }
  normalizedPattern = normalizeMatchTarget(normalizedPattern);
  normalizedTarget = normalizeMatchTarget(normalizedTarget);
  const regex = globToRegExp(normalizedPattern);
  return regex.test(normalizedTarget);
}

export function resolveAllowlistCandidatePath(
  resolution: CommandResolution | null,
  cwd?: string,
): string | undefined {
  if (!resolution) {
    return undefined;
  }
  if (resolution.resolvedPath) {
    return resolution.resolvedPath;
  }
  const raw = resolution.rawExecutable?.trim();
  if (!raw) {
    return undefined;
  }
  const expanded = raw.startsWith("~") ? expandHome(raw) : raw;
  if (!expanded.includes("/") && !expanded.includes("\\")) {
    return undefined;
  }
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  const base = cwd && cwd.trim() ? cwd.trim() : process.cwd();
  return path.resolve(base, expanded);
}

export function matchAllowlist(
  entries: ExecAllowlistEntry[],
  resolution: CommandResolution | null,
): ExecAllowlistEntry | null {
  if (!entries.length || !resolution?.resolvedPath) {
    return null;
  }
  const resolvedPath = resolution.resolvedPath;
  for (const entry of entries) {
    const pattern = entry.pattern?.trim();
    if (!pattern) {
      continue;
    }
    const hasPath = pattern.includes("/") || pattern.includes("\\") || pattern.includes("~");
    if (!hasPath) {
      continue;
    }
    if (matchesPattern(pattern, resolvedPath)) {
      return entry;
    }
  }
  return null;
}

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

const DISALLOWED_PIPELINE_TOKENS = new Set([">", "<", "`", "\n", "\r", "(", ")"]);
const DOUBLE_QUOTE_ESCAPES = new Set(["\\", '"', "$", "`", "\n", "\r"]);
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

function splitShellPipeline(command: string): { ok: boolean; reason?: string; segments: string[] } {
  type HeredocSpec = {
    delimiter: string;
    stripTabs: boolean;
  };

  const parseHeredocDelimiter = (
    source: string,
    start: number,
  ): { delimiter: string; end: number } | null => {
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
          return { delimiter, end: i + 1 };
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
    return { delimiter, end: i };
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
        pendingHeredocs.push({ delimiter: parsed.delimiter, stripTabs });
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
    }
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

function tokenizeShellSegment(segment: string): string[] | null {
  const tokens: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  const pushToken = () => {
    if (buf.length > 0) {
      tokens.push(buf);
      buf = "";
    }
  };

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (!inSingle && !inDouble && ch === "\\") {
      escaped = true;
      continue;
    }
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        buf += ch;
      }
      continue;
    }
    if (inDouble) {
      const next = segment[i + 1];
      if (ch === "\\" && isDoubleQuoteEscape(next)) {
        buf += next;
        i += 1;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (/\s/.test(ch)) {
      pushToken();
      continue;
    }
    buf += ch;
  }

  if (escaped || inSingle || inDouble) {
    return null;
  }
  pushToken();
  return tokens;
}

function parseSegmentsFromParts(
  parts: string[],
  cwd?: string,
  env?: NodeJS.ProcessEnv,
): ExecCommandSegment[] | null {
  const segments: ExecCommandSegment[] = [];
  for (const raw of parts) {
    const argv = tokenizeShellSegment(raw);
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
 * Splits a command string by chain operators (&&, ||, ;) while respecting quotes.
 * Returns null when no chain is present or when the chain is malformed.
 */
export function splitCommandChain(command: string): string[] | null {
  const parts: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  let foundChain = false;
  let invalidChain = false;

  const pushPart = () => {
    const trimmed = buf.trim();
    if (trimmed) {
      parts.push(trimmed);
      buf = "";
      return true;
    }
    buf = "";
    return false;
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

    if (ch === "&" && command[i + 1] === "&") {
      if (!pushPart()) {
        invalidChain = true;
      }
      i += 1;
      foundChain = true;
      continue;
    }
    if (ch === "|" && command[i + 1] === "|") {
      if (!pushPart()) {
        invalidChain = true;
      }
      i += 1;
      foundChain = true;
      continue;
    }
    if (ch === ";") {
      if (!pushPart()) {
        invalidChain = true;
      }
      foundChain = true;
      continue;
    }

    buf += ch;
  }

  const pushedFinal = pushPart();
  if (!foundChain) {
    return null;
  }
  if (invalidChain || !pushedFinal) {
    return null;
  }
  return parts.length > 0 ? parts : null;
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
