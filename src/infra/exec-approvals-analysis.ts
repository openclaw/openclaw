import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  resolveCommandResolutionFromArgv,
  type CommandResolution,
} from "./exec-command-resolution.js";

export {
  matchAllowlist,
  parseExecArgvToken,
  resolveAllowlistCandidatePath,
  resolveApprovalAuditCandidatePath,
  resolveCommandResolution,
  resolveCommandResolutionFromArgv,
  resolveExecutionTargetCandidatePath,
  resolveExecutionTargetResolution,
  resolvePolicyAllowlistCandidatePath,
  resolvePolicyTargetCandidatePath,
  resolvePolicyTargetResolution,
  type CommandResolution,
  type ExecutableResolution,
  type ExecArgvToken,
} from "./exec-command-resolution.js";

export type ExecCommandSegment = {
  raw: string;
  argv: string[];
  sourceArgv?: string[];
  resolution: CommandResolution | null;
};

export type ExecCommandAnalysis = {
  ok: boolean;
  reason?: string;
  segments: ExecCommandSegment[];
  chains?: ExecCommandSegment[][]; // Segments grouped by chain operator (&&, ||, ;)
};

const WINDOWS_UNSUPPORTED_TOKENS = new Set([
  "&",
  "|",
  "<",
  ">",
  ";",
  "^",
  "(",
  ")",
  "%",
  "!",
  "`",
  "\n",
  "\r",
]);

// Characters that remain unsafe even inside double-quoted strings.
// - \n / \r: newlines break command parsing regardless of quoting.
// - %: cmd.exe expands %VAR% inside double quotes, so % can still be used
//   for injection even when quoted.
// - `: PowerShell escape character; forms escape sequences (`n, `0, `") even
//   inside double-quoted strings, so it cannot be safely quoted.
const WINDOWS_ALWAYS_UNSAFE_TOKENS = new Set(["\n", "\r", "%", "`"]);

function findWindowsUnsupportedToken(command: string): string | null {
  let inDouble = false;
  // Single-quote tracking is intentionally omitted here.  cmd.exe (used by the
  // node-host exec path via buildNodeShellCommand) does not recognise single
  // quotes as quoting, so metacharacters inside single-quoted strings remain
  // active at runtime.  Rejecting them at this layer keeps both execution paths
  // (PowerShell gateway and cmd.exe node-host) safe.
  // tokenizeWindowsSegment does track single quotes for accurate argv extraction
  // during enforcement, which is a separate concern from the safety check here.
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '"') {
      inDouble = !inDouble;
      continue;
    }
    // PowerShell expands $var, ${var}, and $(expr) inside double-quoted strings,
    // so $ followed by an identifier-start character, {, or ( is always unsafe —
    // regardless of quoting context.  A bare $ not followed by those characters
    // is safe (e.g. UNC admin share suffix \\host\C$).
    if (ch === "$") {
      const next = command[i + 1];
      // Block $var, ${var}, $(expr), $?  (exit status), and $$ (PID) — all expanded
      // by PowerShell inside double-quoted strings.  A bare $ not followed by these
      // characters is safe (e.g. the UNC admin share suffix \\host\C$).
      if (next !== undefined && /[A-Za-z_{(?$]/.test(next)) {
        return "$";
      }
      continue;
    }
    if (WINDOWS_UNSUPPORTED_TOKENS.has(ch)) {
      // Inside double-quoted strings, most special characters are safe literal
      // values (e.g. "2026-03-28 (土) - LifeLog" contains "()" which are fine).
      // tokenizeWindowsSegment already handles all of these correctly inside quotes.
      if (inDouble && !WINDOWS_ALWAYS_UNSAFE_TOKENS.has(ch)) {
        continue;
      }
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
  let inSingle = false;
  // Set to true when a quote-open is seen; ensures empty quoted args ("" or '')
  // are preserved as empty-string tokens rather than being silently dropped.
  let wasQuoted = false;

  const pushToken = () => {
    if (buf.length > 0 || wasQuoted) {
      tokens.push(buf);
      buf = "";
    }
    wasQuoted = false;
  };

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    // Double-quote toggle (not inside single quotes).
    if (ch === '"' && !inSingle) {
      if (!inDouble) {
        wasQuoted = true;
      }
      inDouble = !inDouble;
      continue;
    }
    // Single-quote toggle (not inside double quotes) — PowerShell literal strings.
    // '' inside a single-quoted string is the PowerShell escape for a literal apostrophe.
    if (ch === "'" && !inDouble) {
      if (inSingle && segment[i + 1] === "'") {
        buf += "'";
        i += 1;
        continue;
      }
      if (!inSingle) {
        wasQuoted = true;
      }
      inSingle = !inSingle;
      continue;
    }
    if (!inDouble && !inSingle && /\s/.test(ch)) {
      pushToken();
      continue;
    }
    buf += ch;
  }

  if (inDouble || inSingle) {
    return null;
  }
  pushToken();
  return tokens.length > 0 ? tokens : null;
}

/**
 * Recursively strip transparent Windows shell wrappers from a command string.
 *
 * LLMs generate commands with arbitrary nesting of shell wrappers:
 *   powershell -NoProfile -Command "& node 'C:\path' --count 3"
 *   cmd /c "node C:\path --count 3"
 *   & node C:\path --count 3
 *
 * All of these should resolve to: node C:\path --count 3
 *
 * Recognised wrappers (applied repeatedly until stable):
 *   - PowerShell call-operator: `& exe args`
 *   - cmd.exe pass-through:    `cmd /c "..."` or `cmd /c ...`
 *   - PowerShell invocation:   `powershell [-flags] -Command "..."`
 */
function stripWindowsShellWrapper(command: string): string {
  const MAX_DEPTH = 5;
  let result = command;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const prev = result;
    result = stripWindowsShellWrapperOnce(result.trim());
    if (result === prev) {
      break;
    }
  }
  return result;
}

function stripWindowsShellWrapperOnce(command: string): string {
  // PowerShell call-operator: & exe args → exe args
  const psCallMatch = command.match(/^&\s+(.+)$/s);
  if (psCallMatch) {
    return psCallMatch[1];
  }

  // PowerShell invocation: powershell[.exe] [-flags] -Command|-c|--command "inner"
  // Also handles pwsh[.exe] and the common -c / --command abbreviations of -Command.
  // Flags before -Command may be bare (-NoProfile) or take a single value
  // (-ExecutionPolicy Bypass, -WindowStyle Hidden).  The lookahead (?!-)
  // prevents a flag value from consuming the next flag name.
  // psFlags matches zero or more PowerShell flags before the command-introducing flag.
  // Each flag is either bare (-NoProfile) or takes a single value.
  // Flag values may be unquoted (-ExecutionPolicy Bypass) or quoted with
  // double-quotes (-WorkingDirectory "C:\Users\Jane Doe\proj") or single-
  // quotes (-WorkingDirectory 'C:\Users\Jane Doe\proj').  \S+ alone cannot
  // match quoted values that contain spaces, so we try double-quoted and
  // single-quoted patterns first, then fall back to \S+ for unquoted values.
  //
  // The negative lookahead (?!c(?:ommand)?\b|-command\b) prevents psFlags from
  // consuming -c or -command as an ordinary flag before the command-introducing
  // flag is matched.  Without it, -c "inner" would be swallowed as a value-taking
  // flag and the outer pattern would never see -c to match against psCommandFlag.
  const psFlags =
    /(?:-(?!c(?:ommand)?\b|-command\b)\w+(?:\s+(?!-)(?:"[^"]*(?:""[^"]*)*"|'[^']*(?:''[^']*)*'|\S+))?\s+)*/i
      .source;
  // Matches -Command, its abbreviation -c, and the --command double-dash alias.
  const psCommandFlag = `(?:-command|-c|--command)`;
  const psInvokeMatch = command.match(
    new RegExp(`^(?:powershell|pwsh)(?:\\.exe)?\\s+${psFlags}${psCommandFlag}\\s+"(.+)"$`, "is"),
  );
  if (psInvokeMatch) {
    // Within a double-quoted -Command argument, "" is the escape sequence for a
    // literal ".  Unescape before passing the payload to the tokenizer so that
    // `powershell -Command "node a.js ""hello world"""` correctly yields the
    // single argv token "hello world" rather than splitting on the space.
    return psInvokeMatch[1].replace(/""/g, '"');
  }
  // PowerShell -Command (or -c/--command) with single-quoted payload
  const psInvokeSingleQuote = command.match(
    new RegExp(`^(?:powershell|pwsh)(?:\\.exe)?\\s+${psFlags}${psCommandFlag}\\s+'(.+)'$`, "is"),
  );
  if (psInvokeSingleQuote) {
    // Inside a PowerShell single-quoted string '' encodes a literal apostrophe.
    // Unescape before tokenizing so that 'node a.js ''hello world''' correctly
    // yields the single argv token "hello world".
    return psInvokeSingleQuote[1].replace(/''/g, "'");
  }
  // PowerShell -Command (or -c/--command) without quotes (bare unquoted payload)
  const psInvokeNoQuote = command.match(
    new RegExp(`^(?:powershell|pwsh)(?:\\.exe)?\\s+${psFlags}${psCommandFlag}\\s+(.+)$`, "is"),
  );
  if (psInvokeNoQuote) {
    return psInvokeNoQuote[1];
  }

  // Note: cmd /c is intentionally NOT stripped here.  If a command is wrapped
  // with `cmd /c`, its inner payload would later be executed by PowerShell, which
  // changes semantics for cmd.exe builtins (dir, copy, etc.).  Callers that submit
  // `cmd /c <thing>` must have an explicit allowlist entry for `cmd` itself, or
  // the command will require user approval.

  return command;
}

function analyzeWindowsShellCommand(params: {
  command: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): ExecCommandAnalysis {
  const effective = stripWindowsShellWrapper(params.command.trim());
  const unsupported = findWindowsUnsupportedToken(effective);
  if (unsupported) {
    return {
      ok: false,
      reason: `unsupported windows shell token: ${unsupported}`,
      segments: [],
    };
  }
  const argv = tokenizeWindowsSegment(effective);
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
  const normalized = normalizeLowercaseStringOrEmpty(platform);
  return normalized.startsWith("win");
}

// Characters that cannot be safely double-quoted in PowerShell enforced commands.
// %   — cmd.exe immediate/delayed expansion; also blocked in analysis phase.
// $id — PowerShell variable expansion: "$env:SECRET", "${var}", "$x" ($ followed by identifier
//       start or {). A bare $ not followed by [A-Za-z_{] is treated literally (e.g. "C$").
// `   — PowerShell escape character; can form escape sequences like `n, `0 inside double quotes.
// Note: ! is intentionally omitted — PowerShell does not treat ! as special in double-quoted
// strings (unlike cmd.exe delayed expansion), so "Hello!" is safe to pass through.
const WINDOWS_UNSAFE_CMD_META = /[%`]|\$(?=[A-Za-z_{(?$])/;

export function windowsEscapeArg(value: string): { ok: true; escaped: string } | { ok: false } {
  if (value === "") {
    return { ok: true, escaped: '""' };
  }
  // Reject tokens containing cmd.exe / PowerShell meta characters that cannot be safely quoted.
  if (WINDOWS_UNSAFE_CMD_META.test(value)) {
    return { ok: false };
  }
  // If the value contains only safe characters, return as-is.
  if (/^[a-zA-Z0-9_./:~\\=-]+$/.test(value)) {
    return { ok: true, escaped: value };
  }
  // Double-quote the value, escaping embedded double-quotes.
  const escaped = value.replace(/"/g, '""');
  return { ok: true, escaped: `"${escaped}"` };
}

type ShellSegmentRenderResult = { ok: true; rendered: string } | { ok: false; reason: string };

function rebuildWindowsShellCommandFromSource(params: {
  command: string;
  renderSegment: (rawSegment: string, segmentIndex: number) => ShellSegmentRenderResult;
}): { ok: boolean; command?: string; reason?: string; segmentCount?: number } {
  const source = stripWindowsShellWrapper(params.command.trim());
  if (!source) {
    return { ok: false, reason: "empty command" };
  }
  const unsupported = findWindowsUnsupportedToken(source);
  if (unsupported) {
    return { ok: false, reason: `unsupported windows shell token: ${unsupported}` };
  }
  const rendered = params.renderSegment(source, 0);
  if (!rendered.ok) {
    return { ok: false, reason: rendered.reason };
  }
  // Prefix with PowerShell call operator (&) so that quoted executable paths
  // (e.g. "C:\Program Files\nodejs\node.exe") are treated as commands, not
  // string literals.  The & operator is harmless for unquoted paths too.
  return { ok: true, command: `& ${rendered.rendered}`, segmentCount: 1 };
}

function renderWindowsQuotedArgv(argv: string[]): ShellSegmentRenderResult {
  const parts: string[] = [];
  for (const token of argv) {
    const result = windowsEscapeArg(token);
    if (!result.ok) {
      return { ok: false, reason: `unsafe windows token: ${token}` };
    }
    parts.push(result.escaped);
  }
  return { ok: true, rendered: parts.join(" ") };
}

function finalizeRebuiltShellCommand(
  rebuilt: ReturnType<typeof rebuildWindowsShellCommandFromSource>,
  expectedSegmentCount?: number,
): { ok: boolean; command?: string; reason?: string } {
  if (!rebuilt.ok) {
    return { ok: false, reason: rebuilt.reason };
  }
  if (typeof expectedSegmentCount === "number" && rebuilt.segmentCount !== expectedSegmentCount) {
    return { ok: false, reason: "segment count mismatch" };
  }
  return { ok: true, command: rebuilt.command };
}

export function resolvePlannedSegmentArgv(segment: ExecCommandSegment): string[] | null {
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
  const execution = segment.resolution?.execution;
  const resolvedExecutable =
    execution?.resolvedRealPath?.trim() ?? execution?.resolvedPath?.trim() ?? "";
  if (resolvedExecutable) {
    argv[0] = resolvedExecutable;
  }
  return argv;
}

export function buildEnforcedShellCommand(params: {
  command: string;
  segments: ExecCommandSegment[];
  platform?: string | null;
}): { ok: boolean; command?: string; reason?: string } {
  if (!isWindowsPlatform(params.platform)) {
    return { ok: false, reason: "posix shell enforcement uses command authorization planner" };
  }
  const rebuilt = rebuildWindowsShellCommandFromSource({
    command: params.command,
    renderSegment: (_raw, segmentIndex) => {
      const seg = params.segments[segmentIndex];
      if (!seg) {
        return { ok: false, reason: "segment mapping failed" };
      }
      const argv = resolvePlannedSegmentArgv(seg);
      if (!argv) {
        return { ok: false, reason: "segment execution plan unavailable" };
      }
      const rendered = renderWindowsQuotedArgv(argv);
      if (!rendered.ok) {
        return rendered;
      }
      return rendered;
    },
  });
  return finalizeRebuiltShellCommand(rebuilt, params.segments.length);
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
  return {
    ok: false,
    reason: "posix shell analysis uses command authorization planner",
    segments: [],
  };
}

export function analyzeArgvCommand(params: {
  argv: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): ExecCommandAnalysis {
  const argv = [...params.argv];
  if (argv.length === 0 || (argv[0]?.trim() ?? "").length === 0) {
    return { ok: false, reason: "empty argv", segments: [] };
  }
  return {
    ok: true,
    segments: [
      {
        raw: argv.join(" "),
        argv,
        sourceArgv: [...params.argv],
        resolution: resolveCommandResolutionFromArgv(argv, params.cwd, params.env),
      },
    ],
  };
}
