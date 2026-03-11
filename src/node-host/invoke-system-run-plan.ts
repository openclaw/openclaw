import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  SystemRunApprovalFileOperand,
  SystemRunApprovalPlan,
} from "../infra/exec-approvals.js";
import { resolveCommandResolutionFromArgv } from "../infra/exec-command-resolution.js";
import {
  POSIX_SHELL_WRAPPERS,
  normalizeExecutableToken,
  unwrapKnownDispatchWrapperInvocation,
  unwrapKnownShellMultiplexerInvocation,
} from "../infra/exec-wrapper-resolution.js";
import { sameFileIdentity } from "../infra/file-identity.js";
import {
  POSIX_INLINE_COMMAND_FLAGS,
  resolveInlineCommandMatch,
} from "../infra/shell-inline-command.js";
import { formatExecCommand, resolveSystemRunCommandRequest } from "../infra/system-run-command.js";

export type ApprovedCwdSnapshot = {
  cwd: string;
  stat: fs.Stats;
};

const MUTABLE_ARGV1_INTERPRETER_PATTERNS = [
  /^(?:node|nodejs)$/,
  /^perl$/,
  /^php$/,
  /^python(?:\d+(?:\.\d+)*)?$/,
  /^ruby$/,
] as const;

const BUN_SUBCOMMANDS = new Set([
  "add",
  "audit",
  "completions",
  "create",
  "exec",
  "help",
  "init",
  "install",
  "link",
  "outdated",
  "patch",
  "pm",
  "publish",
  "remove",
  "repl",
  "run",
  "test",
  "unlink",
  "update",
  "upgrade",
  "x",
]);

const BUN_OPTIONS_WITH_VALUE = new Set([
  "--backend",
  "--bunfig",
  "--conditions",
  "--config",
  "--console-depth",
  "--cwd",
  "--define",
  "--elide-lines",
  "--env-file",
  "--extension-order",
  "--filter",
  "--hot",
  "--inspect",
  "--inspect-brk",
  "--inspect-wait",
  "--install",
  "--jsx-factory",
  "--jsx-fragment",
  "--jsx-import-source",
  "--loader",
  "--origin",
  "--port",
  "--preload",
  "--smol",
  "--tsconfig-override",
  "-c",
  "-e",
  "-p",
  "-r",
]);

const DENO_RUN_OPTIONS_WITH_VALUE = new Set([
  "--cached-only",
  "--cert",
  "--config",
  "--env-file",
  "--ext",
  "--harmony-import-attributes",
  "--import-map",
  "--inspect",
  "--inspect-brk",
  "--inspect-wait",
  "--location",
  "--log-level",
  "--lock",
  "--node-modules-dir",
  "--no-check",
  "--preload",
  "--reload",
  "--seed",
  "--strace-ops",
  "--unstable-bare-node-builtins",
  "--v8-flags",
  "--watch",
  "--watch-exclude",
  "-L",
]);

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function pathComponentsFromRootSync(targetPath: string): string[] {
  const absolute = path.resolve(targetPath);
  const parts: string[] = [];
  let cursor = absolute;
  while (true) {
    parts.unshift(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return parts;
    }
    cursor = parent;
  }
}

function isWritableByCurrentProcessSync(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function hasMutableSymlinkPathComponentSync(targetPath: string): boolean {
  for (const component of pathComponentsFromRootSync(targetPath)) {
    try {
      if (!fs.lstatSync(component).isSymbolicLink()) {
        continue;
      }
      const parentDir = path.dirname(component);
      if (isWritableByCurrentProcessSync(parentDir)) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

function shouldPinExecutableForApproval(params: {
  shellCommand: string | null;
  wrapperChain: string[] | undefined;
}): boolean {
  if (params.shellCommand !== null) {
    return false;
  }
  return (params.wrapperChain?.length ?? 0) === 0;
}

function hashFileContentsSync(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function looksLikePathToken(token: string): boolean {
  return (
    token.startsWith(".") ||
    token.startsWith("/") ||
    token.startsWith("\\") ||
    token.includes("/") ||
    token.includes("\\") ||
    path.extname(token).length > 0
  );
}

function resolvesToExistingFileSync(rawOperand: string, cwd: string | undefined): boolean {
  if (!rawOperand) {
    return false;
  }
  try {
    return fs.statSync(path.resolve(cwd ?? process.cwd(), rawOperand)).isFile();
  } catch {
    return false;
  }
}

function unwrapArgvForMutableOperand(argv: string[]): { argv: string[]; baseIndex: number } {
  let current = argv;
  let baseIndex = 0;
  while (true) {
    const dispatchUnwrap = unwrapKnownDispatchWrapperInvocation(current);
    if (dispatchUnwrap.kind === "unwrapped") {
      baseIndex += current.length - dispatchUnwrap.argv.length;
      current = dispatchUnwrap.argv;
      continue;
    }
    const shellMultiplexerUnwrap = unwrapKnownShellMultiplexerInvocation(current);
    if (shellMultiplexerUnwrap.kind === "unwrapped") {
      baseIndex += current.length - shellMultiplexerUnwrap.argv.length;
      current = shellMultiplexerUnwrap.argv;
      continue;
    }
    return { argv: current, baseIndex };
  }
}

function resolvePosixShellScriptOperandIndex(argv: string[]): number | null {
  if (
    resolveInlineCommandMatch(argv, POSIX_INLINE_COMMAND_FLAGS, {
      allowCombinedC: true,
    }).valueTokenIndex !== null
  ) {
    return null;
  }
  let afterDoubleDash = false;
  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i]?.trim() ?? "";
    if (!token) {
      continue;
    }
    if (token === "-") {
      return null;
    }
    if (!afterDoubleDash && token === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && token === "-s") {
      return null;
    }
    if (!afterDoubleDash && token.startsWith("-")) {
      continue;
    }
    return i;
  }
  return null;
}

function resolveOptionFilteredFileOperandIndex(params: {
  argv: string[];
  startIndex: number;
  cwd: string | undefined;
  optionsWithValue?: ReadonlySet<string>;
}): number | null {
  let afterDoubleDash = false;
  for (let i = params.startIndex; i < params.argv.length; i += 1) {
    const token = params.argv[i]?.trim() ?? "";
    if (!token) {
      continue;
    }
    if (afterDoubleDash) {
      return resolvesToExistingFileSync(token, params.cwd) ? i : null;
    }
    if (token === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (token === "-") {
      return null;
    }
    if (token.startsWith("-")) {
      if (!token.includes("=") && params.optionsWithValue?.has(token)) {
        i += 1;
      }
      continue;
    }
    return resolvesToExistingFileSync(token, params.cwd) ? i : null;
  }
  return null;
}

function resolveOptionFilteredPositionalIndex(params: {
  argv: string[];
  startIndex: number;
  optionsWithValue?: ReadonlySet<string>;
}): number | null {
  let afterDoubleDash = false;
  for (let i = params.startIndex; i < params.argv.length; i += 1) {
    const token = params.argv[i]?.trim() ?? "";
    if (!token) {
      continue;
    }
    if (afterDoubleDash) {
      return i;
    }
    if (token === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (token === "-") {
      return null;
    }
    if (token.startsWith("-")) {
      if (!token.includes("=") && params.optionsWithValue?.has(token)) {
        i += 1;
      }
      continue;
    }
    return i;
  }
  return null;
}

function resolveBunScriptOperandIndex(params: {
  argv: string[];
  cwd: string | undefined;
}): number | null {
  const directIndex = resolveOptionFilteredPositionalIndex({
    argv: params.argv,
    startIndex: 1,
    optionsWithValue: BUN_OPTIONS_WITH_VALUE,
  });
  if (directIndex === null) {
    return null;
  }
  const directToken = params.argv[directIndex]?.trim() ?? "";
  if (directToken === "run") {
    return resolveOptionFilteredFileOperandIndex({
      argv: params.argv,
      startIndex: directIndex + 1,
      cwd: params.cwd,
      optionsWithValue: BUN_OPTIONS_WITH_VALUE,
    });
  }
  if (BUN_SUBCOMMANDS.has(directToken)) {
    return null;
  }
  if (!looksLikePathToken(directToken)) {
    return null;
  }
  return directIndex;
}

function resolveDenoRunScriptOperandIndex(params: {
  argv: string[];
  cwd: string | undefined;
}): number | null {
  if ((params.argv[1]?.trim() ?? "") !== "run") {
    return null;
  }
  return resolveOptionFilteredFileOperandIndex({
    argv: params.argv,
    startIndex: 2,
    cwd: params.cwd,
    optionsWithValue: DENO_RUN_OPTIONS_WITH_VALUE,
  });
}

function resolveMutableFileOperandIndex(argv: string[], cwd: string | undefined): number | null {
  const unwrapped = unwrapArgvForMutableOperand(argv);
  const executable = normalizeExecutableToken(unwrapped.argv[0] ?? "");
  if (!executable) {
    return null;
  }
  if ((POSIX_SHELL_WRAPPERS as ReadonlySet<string>).has(executable)) {
    const shellIndex = resolvePosixShellScriptOperandIndex(unwrapped.argv);
    return shellIndex === null ? null : unwrapped.baseIndex + shellIndex;
  }
  if (!MUTABLE_ARGV1_INTERPRETER_PATTERNS.some((pattern) => pattern.test(executable))) {
    if (executable === "bun") {
      const bunIndex = resolveBunScriptOperandIndex({
        argv: unwrapped.argv,
        cwd,
      });
      return bunIndex === null ? null : unwrapped.baseIndex + bunIndex;
    }
    if (executable === "deno") {
      const denoIndex = resolveDenoRunScriptOperandIndex({
        argv: unwrapped.argv,
        cwd,
      });
      return denoIndex === null ? null : unwrapped.baseIndex + denoIndex;
    }
    return null;
  }
  const operand = unwrapped.argv[1]?.trim() ?? "";
  if (!operand || operand === "-" || operand.startsWith("-")) {
    return null;
  }
  return unwrapped.baseIndex + 1;
}

function resolveMutableFileOperandSnapshotSync(params: {
  argv: string[];
  cwd: string | undefined;
}): { ok: true; snapshot: SystemRunApprovalFileOperand | null } | { ok: false; message: string } {
  const argvIndex = resolveMutableFileOperandIndex(params.argv, params.cwd);
  if (argvIndex === null) {
    return { ok: true, snapshot: null };
  }
  const rawOperand = params.argv[argvIndex]?.trim();
  if (!rawOperand) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires a stable script operand",
    };
  }
  const resolvedPath = path.resolve(params.cwd ?? process.cwd(), rawOperand);
  let realPath: string;
  let stat: fs.Stats;
  try {
    realPath = fs.realpathSync(resolvedPath);
    stat = fs.statSync(realPath);
  } catch {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires an existing script operand",
    };
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires a file script operand",
    };
  }
  return {
    ok: true,
    snapshot: {
      argvIndex,
      path: realPath,
      sha256: hashFileContentsSync(realPath),
    },
  };
}

function resolveCanonicalApprovalCwdSync(cwd: string):
  | {
      ok: true;
      snapshot: ApprovedCwdSnapshot;
    }
  | { ok: false; message: string } {
  const requestedCwd = path.resolve(cwd);
  let cwdLstat: fs.Stats;
  let cwdStat: fs.Stats;
  let cwdReal: string;
  let cwdRealStat: fs.Stats;
  try {
    cwdLstat = fs.lstatSync(requestedCwd);
    cwdStat = fs.statSync(requestedCwd);
    cwdReal = fs.realpathSync(requestedCwd);
    cwdRealStat = fs.statSync(cwdReal);
  } catch {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires an existing canonical cwd",
    };
  }
  if (!cwdStat.isDirectory()) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires cwd to be a directory",
    };
  }
  if (hasMutableSymlinkPathComponentSync(requestedCwd)) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires canonical cwd (no symlink path components)",
    };
  }
  if (cwdLstat.isSymbolicLink()) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires canonical cwd (no symlink cwd)",
    };
  }
  if (
    !sameFileIdentity(cwdStat, cwdLstat) ||
    !sameFileIdentity(cwdStat, cwdRealStat) ||
    !sameFileIdentity(cwdLstat, cwdRealStat)
  ) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval cwd identity mismatch",
    };
  }
  return {
    ok: true,
    snapshot: {
      cwd: cwdReal,
      stat: cwdStat,
    },
  };
}

export function revalidateApprovedCwdSnapshot(params: { snapshot: ApprovedCwdSnapshot }): boolean {
  const current = resolveCanonicalApprovalCwdSync(params.snapshot.cwd);
  if (!current.ok) {
    return false;
  }
  return sameFileIdentity(params.snapshot.stat, current.snapshot.stat);
}

export function revalidateApprovedMutableFileOperand(params: {
  snapshot: SystemRunApprovalFileOperand;
  argv: string[];
  cwd: string | undefined;
}): boolean {
  const operand = params.argv[params.snapshot.argvIndex]?.trim();
  if (!operand) {
    return false;
  }
  const resolvedPath = path.resolve(params.cwd ?? process.cwd(), operand);
  let realPath: string;
  try {
    realPath = fs.realpathSync(resolvedPath);
  } catch {
    return false;
  }
  if (realPath !== params.snapshot.path) {
    return false;
  }
  try {
    return hashFileContentsSync(realPath) === params.snapshot.sha256;
  } catch {
    return false;
  }
}

export function hardenApprovedExecutionPaths(params: {
  approvedByAsk: boolean;
  argv: string[];
  shellCommand: string | null;
  cwd: string | undefined;
}):
  | {
      ok: true;
      argv: string[];
      argvChanged: boolean;
      cwd: string | undefined;
      approvedCwdSnapshot: ApprovedCwdSnapshot | undefined;
    }
  | { ok: false; message: string } {
  if (!params.approvedByAsk) {
    return {
      ok: true,
      argv: params.argv,
      argvChanged: false,
      cwd: params.cwd,
      approvedCwdSnapshot: undefined,
    };
  }

  let hardenedCwd = params.cwd;
  let approvedCwdSnapshot: ApprovedCwdSnapshot | undefined;
  if (hardenedCwd) {
    const canonicalCwd = resolveCanonicalApprovalCwdSync(hardenedCwd);
    if (!canonicalCwd.ok) {
      return canonicalCwd;
    }
    hardenedCwd = canonicalCwd.snapshot.cwd;
    approvedCwdSnapshot = canonicalCwd.snapshot;
  }

  if (params.argv.length === 0) {
    return {
      ok: true,
      argv: params.argv,
      argvChanged: false,
      cwd: hardenedCwd,
      approvedCwdSnapshot,
    };
  }

  const resolution = resolveCommandResolutionFromArgv(params.argv, hardenedCwd);
  if (
    !shouldPinExecutableForApproval({
      shellCommand: params.shellCommand,
      wrapperChain: resolution?.wrapperChain,
    })
  ) {
    // Preserve wrapper semantics for approval-based execution. Pinning the
    // effective executable while keeping wrapper argv shape can shift positional
    // arguments and execute a different command than approved.
    return {
      ok: true,
      argv: params.argv,
      argvChanged: false,
      cwd: hardenedCwd,
      approvedCwdSnapshot,
    };
  }

  const pinnedExecutable = resolution?.resolvedRealPath ?? resolution?.resolvedPath;
  if (!pinnedExecutable) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval requires a stable executable path",
    };
  }

  if (pinnedExecutable === params.argv[0]) {
    return {
      ok: true,
      argv: params.argv,
      argvChanged: false,
      cwd: hardenedCwd,
      approvedCwdSnapshot,
    };
  }

  const argv = [...params.argv];
  argv[0] = pinnedExecutable;
  return {
    ok: true,
    argv,
    argvChanged: true,
    cwd: hardenedCwd,
    approvedCwdSnapshot,
  };
}

export function buildSystemRunApprovalPlan(params: {
  command?: unknown;
  rawCommand?: unknown;
  cwd?: unknown;
  agentId?: unknown;
  sessionKey?: unknown;
}): { ok: true; plan: SystemRunApprovalPlan } | { ok: false; message: string } {
  const command = resolveSystemRunCommandRequest({
    command: params.command,
    rawCommand: params.rawCommand,
  });
  if (!command.ok) {
    return { ok: false, message: command.message };
  }
  if (command.argv.length === 0) {
    return { ok: false, message: "command required" };
  }
  const hardening = hardenApprovedExecutionPaths({
    approvedByAsk: true,
    argv: command.argv,
    shellCommand: command.shellPayload,
    cwd: normalizeString(params.cwd) ?? undefined,
  });
  if (!hardening.ok) {
    return { ok: false, message: hardening.message };
  }
  const commandText = formatExecCommand(hardening.argv);
  const commandPreview =
    command.previewText?.trim() && command.previewText.trim() !== commandText
      ? command.previewText.trim()
      : null;
  const mutableFileOperand = resolveMutableFileOperandSnapshotSync({
    argv: hardening.argv,
    cwd: hardening.cwd,
  });
  if (!mutableFileOperand.ok) {
    return { ok: false, message: mutableFileOperand.message };
  }
  return {
    ok: true,
    plan: {
      argv: hardening.argv,
      cwd: hardening.cwd ?? null,
      commandText,
      commandPreview,
      agentId: normalizeString(params.agentId),
      sessionKey: normalizeString(params.sessionKey),
      mutableFileOperand: mutableFileOperand.snapshot ?? undefined,
    },
  };
}
