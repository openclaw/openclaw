import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  MAX_DISPATCH_WRAPPER_DEPTH,
  hasDispatchEnvManipulation,
  unwrapKnownDispatchWrapperInvocation,
} from "./dispatch-wrapper-resolution.js";
import { normalizeExecutableToken } from "./exec-wrapper-tokens.js";
import {
  hasFishAttachedCommandOption,
  hasFishInitCommandOption,
  hasPowerShellProfileStartupBeforeInlineCommand,
  hasPosixInteractiveStartupBeforeInlineCommand,
  hasPosixLoginStartupBeforeInlineCommand,
  isPowerShellInlineEncodedCommandFlag,
  isPowerShellInlineFileCommandFlag,
  NUSHELL_INLINE_COMMAND_FLAGS,
  POSIX_INLINE_COMMAND_FLAGS,
  resolveInlineCommandMatch,
  resolvePowerShellInlineCommandMatch,
} from "./shell-inline-command.js";

const POSIX_SHELL_WRAPPER_NAMES = [
  "ash",
  "bash",
  "csh",
  "dash",
  "elvish",
  "fish",
  "ksh",
  "mksh",
  "nu",
  "osh",
  "sh",
  "tcsh",
  "xonsh",
  "yash",
  "zsh",
] as const;
// Some shells only share the inline-command flag shape. Keep them wrapper-gated
// without sending non-POSIX grammar through reusable Bash-parser paths.
const POSIX_PARSEABLE_SHELL_WRAPPER_NAMES = [
  "ash",
  "bash",
  "dash",
  "fish",
  "ksh",
  "mksh",
  "sh",
  "yash",
  "zsh",
] as const;
const WINDOWS_CMD_WRAPPER_NAMES = ["cmd"] as const;
const POWERSHELL_WRAPPER_NAMES = ["powershell", "pwsh"] as const;
const SHELL_MULTIPLEXER_WRAPPER_NAMES = ["busybox", "toybox"] as const;
const NUSHELL_STARTUP_OPTIONS_WITH_VALUE = new Set([
  "--config",
  "--env-config",
  "--plugin-config",
  "--plugins",
]);
const OPAQUE_STARTUP_FILE_SHELL_WRAPPERS = new Set(["csh", "osh", "tcsh"]);
function withWindowsExeAliases(names: readonly string[]): string[] {
  return names.flatMap((name) => [name, `${name}.exe`]);
}

export const POSIX_SHELL_WRAPPERS = new Set(withWindowsExeAliases(POSIX_SHELL_WRAPPER_NAMES));
export const POSIX_PARSEABLE_SHELL_WRAPPERS = new Set(
  withWindowsExeAliases(POSIX_PARSEABLE_SHELL_WRAPPER_NAMES),
);
export const POWERSHELL_WRAPPERS = new Set(withWindowsExeAliases(POWERSHELL_WRAPPER_NAMES));

const POSIX_SHELL_WRAPPER_CANONICAL = new Set<string>(POSIX_SHELL_WRAPPER_NAMES);
const WINDOWS_CMD_WRAPPER_CANONICAL = new Set<string>(WINDOWS_CMD_WRAPPER_NAMES);
const POWERSHELL_WRAPPER_CANONICAL = new Set<string>(POWERSHELL_WRAPPER_NAMES);
const SHELL_MULTIPLEXER_WRAPPER_CANONICAL = new Set<string>(SHELL_MULTIPLEXER_WRAPPER_NAMES);
const SHELL_WRAPPER_CANONICAL = new Set<string>([
  ...POSIX_SHELL_WRAPPER_NAMES,
  ...WINDOWS_CMD_WRAPPER_NAMES,
  ...POWERSHELL_WRAPPER_NAMES,
]);

type ShellWrapperKind = "posix" | "cmd" | "powershell";

type ShellWrapperCommand = {
  isWrapper: boolean;
  command: string | null;
};

function resolveShellWrapperCandidate(
  inputArgv: string[],
  inspectEnv = false,
): {
  argv: string[];
  token0: string;
  hasEnvManipulation: boolean;
} | null {
  let argv = inputArgv;
  let hasEnvManipulation = false;
  for (let depth = 0; depth <= MAX_DISPATCH_WRAPPER_DEPTH; depth++) {
    const token0 = argv[0]?.trim();
    if (!token0) {
      return null;
    }
    const dispatch = unwrapKnownDispatchWrapperInvocation(argv);
    if (dispatch.kind === "blocked") {
      return null;
    }
    if (dispatch.kind === "unwrapped") {
      if (inspectEnv) {
        hasEnvManipulation ||= hasDispatchEnvManipulation(argv);
      }
      argv = dispatch.argv;
      continue;
    }
    const multiplexer = unwrapKnownShellMultiplexerInvocation(argv);
    if (multiplexer.kind === "blocked") {
      return null;
    }
    if (multiplexer.kind === "unwrapped") {
      argv = multiplexer.argv;
      continue;
    }
    return { argv, token0, hasEnvManipulation };
  }
  return null;
}

function resolveShellWrapperPayload(
  argv: string[],
  inspectEnv = false,
): {
  argv: string[];
  wrapper: ShellWrapperKind;
  payload: string;
  baseExecutable: string;
  hasEnvManipulation: boolean;
} | null {
  const candidate = resolveShellWrapperCandidate(argv, inspectEnv);
  if (!candidate) {
    return null;
  }

  const baseExecutable = normalizeExecutableToken(candidate.token0);
  const wrapper = findShellWrapperKind(baseExecutable);
  if (!wrapper) {
    return null;
  }

  const payload = extractShellWrapperPayload(candidate.argv, wrapper, baseExecutable);
  if (!payload) {
    return null;
  }

  return { ...candidate, wrapper, payload, baseExecutable };
}

/** Return true when an executable token names a supported shell wrapper. */
export function isShellWrapperExecutable(token: string): boolean {
  return SHELL_WRAPPER_CANONICAL.has(normalizeExecutableToken(token));
}

/** Return true when argv resolves to a shell wrapper invocation. */
export function isShellWrapperInvocation(argv: string[]): boolean {
  const candidate = resolveShellWrapperCandidate(argv);
  return candidate ? isShellWrapperExecutable(candidate.token0) : false;
}

/** Detect implicit POSIX startup in the requested shell, including dispatch wrappers. */
export function hasPosixShellStartupBeforeInlineCommand(argv: string[]): boolean {
  const candidate = resolveShellWrapperCandidate(argv);
  return Boolean(
    candidate &&
    POSIX_SHELL_WRAPPER_CANONICAL.has(normalizeExecutableToken(candidate.token0)) &&
    (hasPosixLoginStartupBeforeInlineCommand(candidate.argv, POSIX_INLINE_COMMAND_FLAGS) ||
      hasPosixInteractiveStartupBeforeInlineCommand(candidate.argv, POSIX_INLINE_COMMAND_FLAGS)),
  );
}

function findShellWrapperKind(baseExecutable: string): ShellWrapperKind | null {
  if (POSIX_SHELL_WRAPPER_CANONICAL.has(baseExecutable)) {
    return "posix";
  }
  if (WINDOWS_CMD_WRAPPER_CANONICAL.has(baseExecutable)) {
    return "cmd";
  }
  return POWERSHELL_WRAPPER_CANONICAL.has(baseExecutable) ? "powershell" : null;
}

type ShellMultiplexerUnwrapResult =
  | { kind: "not-wrapper" }
  | { kind: "blocked"; wrapper: string }
  | { kind: "unwrapped"; wrapper: string; argv: string[] };

/** Unwrap busybox/toybox shell applets or fail closed for ambiguous applets. */
export function unwrapKnownShellMultiplexerInvocation(
  argv: string[],
): ShellMultiplexerUnwrapResult {
  const token0 = argv[0]?.trim();
  if (!token0) {
    return { kind: "not-wrapper" };
  }
  const wrapper = normalizeExecutableToken(token0);
  if (!SHELL_MULTIPLEXER_WRAPPER_CANONICAL.has(wrapper)) {
    return { kind: "not-wrapper" };
  }

  let appletIndex = 1;
  if (argv[appletIndex]?.trim() === "--") {
    appletIndex += 1;
  }
  const applet = argv[appletIndex]?.trim();
  if (!applet || !isShellWrapperExecutable(applet)) {
    return { kind: "blocked", wrapper };
  }

  return { kind: "unwrapped", wrapper, argv: argv.slice(appletIndex) };
}

function extractPosixShellInlineCommand(argv: string[], baseExecutable: string): string | null {
  if (OPAQUE_STARTUP_FILE_SHELL_WRAPPERS.has(baseExecutable)) {
    return null;
  }
  if (baseExecutable === "nu") {
    if (hasNushellStartupOptionBeforeInlineCommand(argv)) {
      return null;
    }
    const attached = extractNushellAttachedInlineCommand(argv);
    if (attached !== null) {
      return attached.trim() || null;
    }
    return resolveInlineCommandMatch(argv, NUSHELL_INLINE_COMMAND_FLAGS, {
      allowCombinedC: true,
    }).command;
  }
  return resolveInlineCommandMatch(argv, POSIX_INLINE_COMMAND_FLAGS, { allowCombinedC: true })
    .command;
}

function hasNushellStartupOptionBeforeInlineCommand(argv: string[]): boolean {
  for (let i = 1; i < argv.length; i += 1) {
    const token = normalizeLowercaseStringOrEmpty(argv[i]);
    if (!token || token === "--") {
      return false;
    }
    if (isNushellInlineCommandBoundary(token)) {
      return false;
    }
    for (const option of NUSHELL_STARTUP_OPTIONS_WITH_VALUE) {
      if (token === option || token.startsWith(`${option}=`)) {
        return true;
      }
    }
  }
  return false;
}

function extractNushellAttachedInlineCommand(argv: string[]): string | null {
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]?.trim() ?? "";
    if (!arg || arg === "--") {
      return null;
    }
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }
    const flag = normalizeLowercaseStringOrEmpty(arg.slice(0, equalsIndex));
    if (flag.startsWith("--") && NUSHELL_INLINE_COMMAND_FLAGS.has(flag)) {
      return arg.slice(equalsIndex + 1);
    }
  }
  return null;
}

function isNushellInlineCommandBoundary(arg: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(arg);
  if (NUSHELL_INLINE_COMMAND_FLAGS.has(normalized)) {
    return true;
  }
  const equalsIndex = normalized.indexOf("=");
  if (equalsIndex === -1) {
    return false;
  }
  const flag = normalized.slice(0, equalsIndex);
  return flag.startsWith("--") && NUSHELL_INLINE_COMMAND_FLAGS.has(flag);
}

function extractCmdInlineCommand(argv: string[]): string | null {
  const idx = argv.findIndex((item) => {
    const token = normalizeLowercaseStringOrEmpty(item);
    return token === "/c" || token === "/k" || token === "-c" || token === "-k";
  });
  if (idx === -1) {
    return null;
  }
  const cmd = argv
    .slice(idx + 1)
    .join(" ")
    .trim();
  return cmd.length > 0 ? cmd : null;
}

function hasCmdUnreviewedStartupBeforeInlineCommand(argv: string[]): boolean {
  let autoRunDisabled = false;
  for (let index = 1; index < argv.length; index += 1) {
    const token = normalizeLowercaseStringOrEmpty(argv[index]);
    if (!token) {
      continue;
    }
    if (token === "/d") {
      autoRunDisabled = true;
      continue;
    }
    if (token === "/k") {
      return true;
    }
    if (token === "/c") {
      return !autoRunDisabled || !argv.slice(index + 1).some((value) => value.trim().length > 0);
    }
    if (
      token === "/s" ||
      token === "/q" ||
      token === "/a" ||
      token === "/u" ||
      /^\/t:[\da-f]{1,2}$/u.test(token) ||
      token === "/e:on" ||
      token === "/e:off" ||
      token === "/f:on" ||
      token === "/f:off" ||
      token === "/v:on" ||
      token === "/v:off"
    ) {
      continue;
    }
    return true;
  }
  return true;
}

function extractShellWrapperPayload(
  argv: string[],
  kind: ShellWrapperKind,
  baseExecutable: string,
): string | null {
  if (kind === "posix") {
    return extractPosixShellInlineCommand(argv, baseExecutable);
  }
  if (kind === "cmd") {
    return extractCmdInlineCommand(argv);
  }
  return resolvePowerShellInlineCommandMatch(argv).command;
}

function isLegacyShLoginInlineForm(argv: string[], baseExecutable: string): boolean {
  return baseExecutable === "sh" && argv[1]?.trim() === "-lc";
}

/** Format argv with minimal shell-style quoting for display and consistency checks. */
export function formatExecCommand(argv: string[]): string {
  return argv
    .map((arg) => {
      if (arg.length === 0) {
        return '""';
      }
      return /\s|"/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
    })
    .join(" ");
}

function startupWrapperRequiresFullArgv(params: {
  argv: string[];
  kind: ShellWrapperKind;
  baseExecutable: string;
  includeLegacyLoginInlineForm: boolean;
}): boolean {
  if (params.kind !== "posix") {
    return false;
  }
  if (params.baseExecutable === "fish" && hasFishInitCommandOption(params.argv)) {
    return true;
  }
  if (params.baseExecutable === "nu") {
    return hasNushellStartupBeforeInlineCommand(params.argv);
  }
  if (
    POSIX_SHELL_WRAPPER_CANONICAL.has(params.baseExecutable) &&
    hasPosixLoginStartupBeforeInlineCommand(params.argv, POSIX_INLINE_COMMAND_FLAGS)
  ) {
    return (
      params.includeLegacyLoginInlineForm ||
      !isLegacyShLoginInlineForm(params.argv, params.baseExecutable)
    );
  }
  return hasPosixInteractiveStartupBeforeInlineCommand(params.argv, POSIX_INLINE_COMMAND_FLAGS);
}

function hasNushellStartupBeforeInlineCommand(argv: string[]): boolean {
  let sawStartupMode = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]?.trim() ?? "";
    if (!arg || arg === "--") {
      return false;
    }
    const normalized = normalizeLowercaseStringOrEmpty(arg);
    if (
      normalized === "--login" ||
      normalized === "--interactive" ||
      (normalized.startsWith("-") &&
        !normalized.startsWith("--") &&
        /[li]/.test(normalized.slice(1)))
    ) {
      sawStartupMode = true;
    }
    if (isNushellInlineCommandBoundary(arg)) {
      return sawStartupMode;
    }
    if (!arg.startsWith("-") && !arg.startsWith("+")) {
      return false;
    }
  }
  return false;
}

/** Return true when dispatch wrappers set env before the shell wrapper. */
export function hasEnvManipulationBeforeShellWrapper(argv: string[]): boolean {
  return resolveShellWrapperPayload(argv, true)?.hasEnvManipulation ?? false;
}

/** Classify shell wrapper argv and return the approval-display command when safe. */
export function extractShellWrapperCommand(
  argv: string[],
  rawCommandInput?: string | null,
): ShellWrapperCommand {
  const rawCommand = rawCommandInput?.trim() || null;
  const candidate = resolveShellWrapperPayload(argv);
  if (!candidate) {
    return { isWrapper: false, command: null };
  }
  const { baseExecutable, wrapper, payload } = candidate;
  if (
    wrapper === "posix" &&
    baseExecutable === "fish" &&
    hasFishAttachedCommandOption(candidate.argv)
  ) {
    return { isWrapper: true, command: null };
  }
  const rawMatchesPayload = rawCommand === payload;
  const rawMatchesCanonicalArgv = rawCommand === formatExecCommand(candidate.argv);
  const allowLegacyShLoginPayloadBinding =
    isLegacyShLoginInlineForm(candidate.argv, baseExecutable) &&
    (rawMatchesPayload || rawMatchesCanonicalArgv);
  if (
    startupWrapperRequiresFullArgv({
      argv: candidate.argv,
      kind: wrapper,
      baseExecutable,
      includeLegacyLoginInlineForm: !allowLegacyShLoginPayloadBinding,
    })
  ) {
    return { isWrapper: true, command: null };
  }

  return {
    isWrapper: true,
    command: rawMatchesCanonicalArgv ? payload : (rawCommand ?? payload),
  };
}

/** Resolve the argv segment that should be transported for shell execution. */
export function resolveShellWrapperTransportArgv(argv: string[]): string[] | null {
  return resolveShellWrapperPayload(argv)?.argv ?? null;
}

/** Extract the raw inline command payload from a shell wrapper argv. */
export function extractShellWrapperInlineCommand(argv: string[]): string | null {
  return resolveShellWrapperPayload(argv)?.payload ?? null;
}

/** Extract a command payload only when it is safe to bind to raw command text. */
export function extractBindableShellWrapperInlineCommand(
  argv: string[],
  rawCommand?: string | null,
): string | null {
  return extractShellWrapperCommand(argv, rawCommand).command;
}

/** Return true when shell wrapper startup behavior blocks command rebinding. */
export function isBlockedShellWrapperCommand(argv: string[], rawCommand?: string | null): boolean {
  const candidate = resolveShellWrapperCandidate(argv);
  if (!candidate) {
    return false;
  }
  const baseExecutable = normalizeExecutableToken(candidate.token0);
  const wrapper = findShellWrapperKind(baseExecutable);
  if (!wrapper) {
    return false;
  }
  // cmd.exe runs registry AutoRun before /c; /k and bare invocations keep
  // consuming unreviewed stdin. Only an explicit /d /c payload is bindable.
  if (wrapper === "cmd" && hasCmdUnreviewedStartupBeforeInlineCommand(candidate.argv)) {
    return true;
  }
  if (wrapper === "powershell") {
    const { command, valueTokenIndex } = resolvePowerShellInlineCommandMatch(candidate.argv);
    // Profiles run before the payload; encoded commands and mutable script
    // files have no content bound to the approval. Escalate each to a human.
    if (
      hasPowerShellProfileStartupBeforeInlineCommand(candidate.argv, valueTokenIndex) ||
      (valueTokenIndex !== null &&
        (command === "-" ||
          isPowerShellInlineEncodedCommandFlag(candidate.argv[valueTokenIndex - 1] ?? "") ||
          isPowerShellInlineFileCommandFlag(candidate.argv[valueTokenIndex - 1] ?? "")))
    ) {
      return true;
    }
  }
  if (wrapper === "posix") {
    // Startup options can consume their own payload before -c is reachable.
    // Classify them first so profile/init execution never disappears as an
    // unrecognized shell invocation.
    if (
      (baseExecutable === "fish" && hasFishInitCommandOption(candidate.argv)) ||
      (baseExecutable === "nu" && hasNushellStartupOptionBeforeInlineCommand(candidate.argv))
    ) {
      return true;
    }
  }
  if (wrapper === "posix" && OPAQUE_STARTUP_FILE_SHELL_WRAPPERS.has(baseExecutable)) {
    return true;
  }
  const extracted = extractShellWrapperCommand(argv, rawCommand);
  return extracted.isWrapper && extracted.command === null;
}
