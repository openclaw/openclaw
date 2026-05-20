/** Builds and revalidates system.run approval plans for cwd and mutable executable operands. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeNullableString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../config/paths.js";
import { detectInterpreterInlineEvalArgv } from "../infra/command-analysis/inline-eval.js";
import type {
  SystemRunApprovalFileOperand,
  SystemRunApprovalPlan,
} from "../infra/exec-approvals.js";
import { resolveCommandResolutionFromArgv } from "../infra/exec-command-resolution.js";
import { isInterpreterLikeSafeBin } from "../infra/exec-safe-bin-runtime-policy.js";
import {
  isBlockedShellWrapperCommand,
  POSIX_SHELL_WRAPPERS,
  normalizeExecutableToken,
  unwrapKnownDispatchWrapperInvocation,
  unwrapKnownShellMultiplexerInvocation,
} from "../infra/exec-wrapper-resolution.js";
import { sameFileIdentity } from "../infra/fs-safe-advanced.js";
import { parseInlineOptionToken } from "../infra/inline-option-token.js";
import {
  normalizePackageManagerExecToken,
  PNPM_CASE_SENSITIVE_OPTIONS_WITH_VALUE,
  PNPM_DLX_OPTIONS_WITH_VALUE,
  PNPM_FLAG_OPTIONS,
  PNPM_OPTIONS_WITH_VALUE,
  unwrapKnownPackageManagerExecInvocation,
} from "../infra/package-manager-exec-wrapper.js";
import {
  advancePosixInlineOptionScan,
  POSIX_INLINE_COMMAND_FLAGS,
  resolveInlineCommandMatch,
} from "../infra/shell-inline-command.js";
import { formatExecCommand, resolveSystemRunCommandRequest } from "../infra/system-run-command.js";
import { splitShellArgs } from "../utils/shell-argv.js";

/** File identity snapshot for the approved working directory. */
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

const GENERIC_MUTABLE_SCRIPT_RUNNERS = new Set([
  "esno",
  "jiti",
  "ts-node",
  "ts-node-esm",
  "tsx",
  "vite-node",
]);

const OPAQUE_MUTABLE_SCRIPT_RUNNERS = new Set(["busybox", "toybox"]);

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

const NODE_OPTIONS_WITH_FILE_VALUE = new Set([
  "-r",
  "--experimental-loader",
  "--import",
  "--loader",
  "--require",
]);

const RUBY_UNSAFE_APPROVAL_FLAGS = new Set(["-I", "-r", "--require"]);
const PERL_UNSAFE_APPROVAL_FLAGS = new Set(["-I", "-M", "-m"]);

type MaterializedInlineEvalCommand = {
  argv: string[];
  scriptPath: string;
};

type InlineEvalInterpreterSnapshot = {
  resolvedPath: string;
  resolvedRealPath: string;
};

function normalizeOptionFlag(token: string): string {
  return normalizeLowercaseStringOrEmpty(parseInlineOptionToken(token).name);
}

function readTrimmedArgToken(argv: readonly string[], index: number): string {
  return normalizeNullableString(argv[index]) ?? "";
}

function resolveInlineEvalScriptExtension(normalizedExecutable: string): string | null {
  if (/^(?:python|python\d+(?:\.\d+)*|pypy|pypy\d*)$/.test(normalizedExecutable)) {
    return ".py";
  }
  if (normalizedExecutable === "node" || normalizedExecutable === "nodejs") {
    return ".cjs";
  }
  return null;
}

function resolveMaterializableInlineEvalCodeIndex(argv: string[], flag: string): number | null {
  if (argv.length !== 3) {
    return null;
  }
  return readTrimmedArgToken(argv, 1) === flag ? 2 : null;
}

function renderMaterializedInlineEvalScript(params: {
  normalizedExecutable: string;
  flag: string;
  code: string;
  interpreter?: InlineEvalInterpreterSnapshot;
}): string | null {
  if (/^(?:python|python\d+(?:\.\d+)*|pypy|pypy\d*)$/.test(params.normalizedExecutable)) {
    if (!params.interpreter) {
      return null;
    }
    return [
      "import os as __openclaw_inline_eval_os",
      "",
      `__openclaw_inline_eval_interpreter = ${JSON.stringify(params.interpreter.resolvedPath)}`,
      `__openclaw_inline_eval_interpreter_realpath = ${JSON.stringify(
        params.interpreter.resolvedRealPath,
      )}`,
      "if (",
      "    __openclaw_inline_eval_os.path.realpath(__openclaw_inline_eval_interpreter)",
      "    != __openclaw_inline_eval_interpreter_realpath",
      "):",
      "    raise SystemExit('SYSTEM_RUN_DENIED: inline-eval interpreter changed before execution')",
      `__openclaw_inline_eval_code = ${JSON.stringify(params.code)}`,
      "__openclaw_inline_eval_env = __openclaw_inline_eval_os.environ.copy()",
      "__openclaw_inline_eval_env['__PYVENV_LAUNCHER__'] = __openclaw_inline_eval_interpreter",
      "__openclaw_inline_eval_os.execve(",
      "    __openclaw_inline_eval_interpreter_realpath,",
      "    [__openclaw_inline_eval_interpreter, '-c', __openclaw_inline_eval_code],",
      "    __openclaw_inline_eval_env,",
      ")",
      "",
    ].join("\n");
  }
  if (params.normalizedExecutable === "node" || params.normalizedExecutable === "nodejs") {
    return [
      `const __openclawInlineEvalFlag = ${JSON.stringify(params.flag)};`,
      `const __openclawInlineEvalCode = ${JSON.stringify(params.code)};`,
      'if (typeof process.execve !== "function") {',
      '  throw new Error("SYSTEM_RUN_DENIED: inline-eval exec replacement unavailable");',
      "}",
      "process.execve(",
      "  process.execPath,",
      "  [process.execPath, __openclawInlineEvalFlag, __openclawInlineEvalCode],",
      "  process.env,",
      ");",
      "",
    ].join("\n");
  }
  return null;
}

function ensureUserPrivateDirectory(dir: string): { ok: true } | { ok: false; message: string } {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      return { ok: false, message: "SYSTEM_RUN_DENIED: inline-eval temp dir is unsafe" };
    }
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && typeof stat.uid === "number" && stat.uid !== uid) {
      return { ok: false, message: "SYSTEM_RUN_DENIED: inline-eval temp dir owner mismatch" };
    }
    if ((stat.mode & 0o077) !== 0) {
      fs.chmodSync(dir, 0o700);
    }
    return { ok: true };
  } catch {
    return { ok: false, message: "SYSTEM_RUN_DENIED: unable to prepare inline-eval temp dir" };
  }
}

function writeMaterializedInlineEvalScriptSync(params: {
  normalizedExecutable: string;
  flag: string;
  code: string;
  extension: string;
  interpreter?: InlineEvalInterpreterSnapshot;
}): { ok: true; scriptPath: string } | { ok: false; message: string } {
  const scriptBody = renderMaterializedInlineEvalScript({
    normalizedExecutable: params.normalizedExecutable,
    flag: params.flag,
    code: params.code,
    interpreter: params.interpreter,
  });
  if (scriptBody === null) {
    return { ok: false, message: "SYSTEM_RUN_DENIED: unable to materialize inline-eval script" };
  }
  const tmpDir = path.join(resolveStateDir(), "tmp");
  const tmp = ensureUserPrivateDirectory(tmpDir);
  if (!tmp.ok) {
    return tmp;
  }
  const inlineEvalDir = path.join(tmpDir, "inline-eval");
  const dir = ensureUserPrivateDirectory(inlineEvalDir);
  if (!dir.ok) {
    return dir;
  }

  const digest = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        interpreter: params.normalizedExecutable,
        flag: params.flag,
        extension: params.extension,
        code: params.code,
        interpreterSnapshot: params.interpreter,
        runtimeWrapper: "cwd-eval-v1",
      }),
    )
    .digest("hex");
  const scriptPath = path.join(inlineEvalDir, `${digest}${params.extension}`);
  const tmpScriptPath = path.join(
    inlineEvalDir,
    `.${digest}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(tmpScriptPath, scriptBody, { flag: "wx", mode: 0o600 });
    fs.chmodSync(tmpScriptPath, 0o600);
    fs.renameSync(tmpScriptPath, scriptPath);
    fs.chmodSync(scriptPath, 0o600);
    return { ok: true, scriptPath };
  } catch {
    try {
      fs.rmSync(tmpScriptPath, { force: true });
    } catch {
      // Best effort cleanup only.
    }
    return { ok: false, message: "SYSTEM_RUN_DENIED: unable to materialize inline-eval script" };
  }
}

export function isMaterializedInlineEvalApprovalPlan(
  plan: SystemRunApprovalPlan | null | undefined,
): boolean {
  if (!plan?.commandPreview || !plan.mutableFileOperand) {
    return false;
  }
  const scriptPath = plan.argv[plan.mutableFileOperand.argvIndex];
  if (!scriptPath) {
    return false;
  }
  let scriptRealPath: string;
  try {
    scriptRealPath = fs.realpathSync(scriptPath);
  } catch {
    return false;
  }
  if (scriptRealPath !== plan.mutableFileOperand.path) {
    return false;
  }
  const normalizedScriptPath = path.normalize(scriptRealPath);
  const inlineEvalSegment = `${path.sep}tmp${path.sep}inline-eval${path.sep}`;
  return normalizedScriptPath.includes(inlineEvalSegment);
}

export function materializeInlineEvalForApprovalSync(
  argv: string[],
  cwd?: string,
): { ok: true; command: MaterializedInlineEvalCommand | null } | { ok: false; message: string } {
  if (process.platform === "win32") {
    return { ok: true, command: null };
  }
  const hit = detectInterpreterInlineEvalArgv(argv);
  if (!hit) {
    return { ok: true, command: null };
  }
  const extension = resolveInlineEvalScriptExtension(hit.normalizedExecutable);
  if (!extension || (hit.flag !== "-c" && hit.flag !== "-e" && hit.flag !== "--eval")) {
    return { ok: true, command: null };
  }
  const codeIndex = resolveMaterializableInlineEvalCodeIndex(argv, hit.flag);
  if (codeIndex === null) {
    return { ok: true, command: null };
  }
  const code = argv[codeIndex] ?? "";
  const resolution = resolveCommandResolutionFromArgv(argv, cwd);
  const interpreter =
    resolution?.execution.resolvedPath && resolution.execution.resolvedRealPath
      ? {
          resolvedPath: resolution.execution.resolvedPath,
          resolvedRealPath: resolution.execution.resolvedRealPath,
        }
      : undefined;
  const materialized = writeMaterializedInlineEvalScriptSync({
    normalizedExecutable: hit.normalizedExecutable,
    flag: hit.flag,
    code,
    extension,
    interpreter,
  });
  if (!materialized.ok) {
    return materialized;
  }
  const flagIndex = codeIndex - 1;
  return {
    ok: true,
    command: {
      argv: [...argv.slice(0, flagIndex), materialized.scriptPath, ...argv.slice(codeIndex + 1)],
      scriptPath: materialized.scriptPath,
    },
  };
}

const POSIX_SHELL_OPTIONS_WITH_VALUE = new Set([
  "--init-file",
  "--rcfile",
  "--startup-script",
  "-O",
  "-o",
  "+O",
  "+o",
]);

const POSIX_SHELLS_WITH_PLUS_OPTIONS = new Set(["ash", "bash", "dash", "ksh", "sh", "zsh"]);

function isPosixShellOptionToken(token: string, supportsPlusOptions: boolean): boolean {
  return token.startsWith("-") || (supportsPlusOptions && token.startsWith("+"));
}

type FileOperandCollection = {
  hits: number[];
  sawOptionValueFile: boolean;
};

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

function isOwnedByCurrentProcessSync(candidate: string): boolean {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    return false;
  }
  try {
    return fs.statSync(candidate).uid === process.getuid();
  } catch {
    return false;
  }
}

function isMutableByCurrentProcessSync(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.W_OK);
    return true;
  } catch {
    return isOwnedByCurrentProcessSync(candidate);
  }
}

function hasMutableSymlinkPathComponentSync(targetPath: string): boolean {
  for (const component of pathComponentsFromRootSync(targetPath)) {
    try {
      if (!fs.lstatSync(component).isSymbolicLink()) {
        continue;
      }
      const parentDir = path.dirname(component);
      if (isMutableByCurrentProcessSync(parentDir)) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

function pathLooksMutableForShellPayloadSync(targetPath: string): boolean {
  if (
    isMutableByCurrentProcessSync(targetPath) ||
    isMutableByCurrentProcessSync(path.dirname(targetPath)) ||
    hasMutableSymlinkPathComponentSync(targetPath)
  ) {
    return true;
  }
  let realPath: string;
  try {
    realPath = fs.realpathSync(targetPath);
  } catch {
    return true;
  }
  return (
    isMutableByCurrentProcessSync(realPath) ||
    isMutableByCurrentProcessSync(path.dirname(realPath)) ||
    hasMutableSymlinkPathComponentSync(realPath)
  );
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

function isKnownBinaryExecutableHeader(buffer: Buffer): boolean {
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    return true;
  }
  if (
    buffer.length >= 4 &&
    (buffer.subarray(0, 4).equals(Buffer.from([0xfe, 0xed, 0xfa, 0xce])) ||
      buffer.subarray(0, 4).equals(Buffer.from([0xce, 0xfa, 0xed, 0xfe])) ||
      buffer.subarray(0, 4).equals(Buffer.from([0xfe, 0xed, 0xfa, 0xcf])) ||
      buffer.subarray(0, 4).equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe])) ||
      buffer.subarray(0, 4).equals(Buffer.from([0xca, 0xfe, 0xba, 0xbe])) ||
      buffer.subarray(0, 4).equals(Buffer.from([0xbe, 0xba, 0xfe, 0xca])) ||
      buffer.subarray(0, 4).equals(Buffer.from([0xca, 0xfe, 0xba, 0xbf])) ||
      buffer.subarray(0, 4).equals(Buffer.from([0xbf, 0xba, 0xfe, 0xca])))
  ) {
    return true;
  }
  if (buffer.length < 0x40 || !buffer.subarray(0, 2).equals(Buffer.from([0x4d, 0x5a]))) {
    return false;
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  return (
    peOffset >= 0 &&
    peOffset <= buffer.length - 4 &&
    buffer.subarray(peOffset, peOffset + 4).equals(Buffer.from([0x50, 0x45, 0x00, 0x00]))
  );
}

function isLikelyScriptLikePathSync(targetPath: string): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    return true;
  }
  if (!stat.isFile()) {
    return true;
  }
  let header: Buffer;
  try {
    const fd = fs.openSync(targetPath, "r");
    try {
      header = Buffer.alloc(1024);
      const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
      header = header.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return true;
  }
  if (header.length === 0) {
    return true;
  }
  if (header.subarray(0, 2).equals(Buffer.from("#!"))) {
    return true;
  }
  if (isKnownBinaryExecutableHeader(header)) {
    return false;
  }
  return true;
}

function unwrapArgvForMutableOperand(argv: string[]): {
  argv: string[];
  baseIndex: number;
  opaqueMultiplexerSeen: boolean;
} {
  let current = argv;
  let baseIndex = 0;
  let opaqueMultiplexerSeen = false;
  while (true) {
    const dispatchUnwrap = unwrapKnownDispatchWrapperInvocation(current);
    if (dispatchUnwrap.kind === "unwrapped") {
      baseIndex += current.length - dispatchUnwrap.argv.length;
      current = dispatchUnwrap.argv;
      continue;
    }
    const shellMultiplexerUnwrap = unwrapKnownShellMultiplexerInvocation(current);
    if (shellMultiplexerUnwrap.kind === "unwrapped") {
      if (OPAQUE_MUTABLE_SCRIPT_RUNNERS.has(shellMultiplexerUnwrap.wrapper)) {
        opaqueMultiplexerSeen = true;
      }
      baseIndex += current.length - shellMultiplexerUnwrap.argv.length;
      current = shellMultiplexerUnwrap.argv;
      continue;
    }
    const packageManagerUnwrap = unwrapKnownPackageManagerExecInvocation(current);
    if (packageManagerUnwrap) {
      baseIndex += current.length - packageManagerUnwrap.length;
      current = packageManagerUnwrap;
      continue;
    }
    return { argv: current, baseIndex, opaqueMultiplexerSeen };
  }
}

function resolvePosixShellScriptOperandIndex(argv: string[], executable: string): number | null {
  const supportsPlusOptions = POSIX_SHELLS_WITH_PLUS_OPTIONS.has(executable);
  if (
    resolveInlineCommandMatch(argv, POSIX_INLINE_COMMAND_FLAGS, {
      allowCombinedC: true,
      isOptionToken: (token) => isPosixShellOptionToken(token, supportsPlusOptions),
      stopAtFirstNonOption: true,
    }).valueTokenIndex !== null
  ) {
    return null;
  }
  let afterDoubleDash = false;
  for (let i = 1; i < argv.length; i += 1) {
    const token = readTrimmedArgToken(argv, i);
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
    if (!afterDoubleDash && isPosixShellOptionToken(token, supportsPlusOptions)) {
      const flag = normalizeOptionFlag(token);
      if (POSIX_SHELL_OPTIONS_WITH_VALUE.has(flag)) {
        if (!token.includes("=")) {
          i += 1;
        }
        continue;
      }
      i += advancePosixInlineOptionScan(token) - 1;
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
    const token = readTrimmedArgToken(params.argv, i);
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
    const token = readTrimmedArgToken(params.argv, i);
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

function collectExistingFileOperandIndexes(params: {
  argv: string[];
  startIndex: number;
  cwd: string | undefined;
  optionsWithFileValue?: ReadonlySet<string>;
}): FileOperandCollection {
  let afterDoubleDash = false;
  const hits: number[] = [];
  for (let i = params.startIndex; i < params.argv.length; i += 1) {
    const token = readTrimmedArgToken(params.argv, i);
    if (!token) {
      continue;
    }
    if (afterDoubleDash) {
      if (resolvesToExistingFileSync(token, params.cwd)) {
        hits.push(i);
      }
      continue;
    }
    if (token === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (token === "-") {
      return { hits: [], sawOptionValueFile: false };
    }
    if (token.startsWith("-")) {
      const option = parseInlineOptionToken(token);
      const flag = option.name;
      const inlineValue = option.hasInlineValue ? option.inlineValue : undefined;
      if (params.optionsWithFileValue?.has(normalizeLowercaseStringOrEmpty(flag))) {
        if (inlineValue && resolvesToExistingFileSync(inlineValue, params.cwd)) {
          hits.push(i);
          return { hits, sawOptionValueFile: true };
        }
        const nextToken = readTrimmedArgToken(params.argv, i + 1);
        if (!inlineValue && nextToken && resolvesToExistingFileSync(nextToken, params.cwd)) {
          hits.push(i + 1);
          return { hits, sawOptionValueFile: true };
        }
      }
      continue;
    }
    if (resolvesToExistingFileSync(token, params.cwd)) {
      hits.push(i);
    }
  }
  return { hits, sawOptionValueFile: false };
}

function resolveGenericInterpreterScriptOperandIndex(params: {
  argv: string[];
  cwd: string | undefined;
  optionsWithFileValue?: ReadonlySet<string>;
}): number | null {
  const collection = collectExistingFileOperandIndexes({
    argv: params.argv,
    startIndex: 1,
    cwd: params.cwd,
    optionsWithFileValue: params.optionsWithFileValue,
  });
  if (collection.sawOptionValueFile) {
    return null;
  }
  return collection.hits.length === 1 ? expectDefined(collection.hits[0], "hits entry at 0") : null;
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
  const directToken = readTrimmedArgToken(params.argv, directIndex);
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
  if (readTrimmedArgToken(params.argv, 1) !== "run") {
    return null;
  }
  return resolveOptionFilteredFileOperandIndex({
    argv: params.argv,
    startIndex: 2,
    cwd: params.cwd,
    optionsWithValue: DENO_RUN_OPTIONS_WITH_VALUE,
  });
}

function hasRubyUnsafeApprovalFlag(argv: string[]): boolean {
  let afterDoubleDash = false;
  for (let i = 1; i < argv.length; i += 1) {
    const token = readTrimmedArgToken(argv, i);
    if (!token) {
      continue;
    }
    if (afterDoubleDash) {
      return false;
    }
    if (token === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (token === "-I" || token === "-r") {
      return true;
    }
    if (token.startsWith("-I") || token.startsWith("-r")) {
      return true;
    }
    if (RUBY_UNSAFE_APPROVAL_FLAGS.has(normalizeLowercaseStringOrEmpty(token))) {
      return true;
    }
  }
  return false;
}

function hasPerlUnsafeApprovalFlag(argv: string[]): boolean {
  let afterDoubleDash = false;
  for (let i = 1; i < argv.length; i += 1) {
    const token = readTrimmedArgToken(argv, i);
    if (!token) {
      continue;
    }
    if (afterDoubleDash) {
      return false;
    }
    if (token === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (token === "-I" || token === "-M" || token === "-m") {
      return true;
    }
    if (token.startsWith("-I") || token.startsWith("-M") || token.startsWith("-m")) {
      return true;
    }
    if (PERL_UNSAFE_APPROVAL_FLAGS.has(token)) {
      return true;
    }
  }
  return false;
}

function isMutableScriptRunner(executable: string): boolean {
  return (
    GENERIC_MUTABLE_SCRIPT_RUNNERS.has(executable) ||
    OPAQUE_MUTABLE_SCRIPT_RUNNERS.has(executable) ||
    isInterpreterLikeSafeBin(executable)
  );
}

function resolveMutableFileOperandIndex(argv: string[], cwd: string | undefined): number | null {
  const unwrapped = unwrapArgvForMutableOperand(argv);
  const executable = normalizeExecutableToken(unwrapped.argv[0] ?? "");
  if (!executable) {
    return null;
  }
  if (unwrapped.opaqueMultiplexerSeen || OPAQUE_MUTABLE_SCRIPT_RUNNERS.has(executable)) {
    return null;
  }
  if ((POSIX_SHELL_WRAPPERS as ReadonlySet<string>).has(executable)) {
    const shellIndex = resolvePosixShellScriptOperandIndex(unwrapped.argv, executable);
    return shellIndex === null ? null : unwrapped.baseIndex + shellIndex;
  }
  if (MUTABLE_ARGV1_INTERPRETER_PATTERNS.some((pattern) => pattern.test(executable))) {
    const operand = readTrimmedArgToken(unwrapped.argv, 1);
    if (operand && operand !== "-" && !operand.startsWith("-")) {
      return unwrapped.baseIndex + 1;
    }
  }
  if (executable === "bun") {
    const bunIndex = resolveBunScriptOperandIndex({
      argv: unwrapped.argv,
      cwd,
    });
    if (bunIndex !== null) {
      return unwrapped.baseIndex + bunIndex;
    }
  }
  if (executable === "deno") {
    const denoIndex = resolveDenoRunScriptOperandIndex({
      argv: unwrapped.argv,
      cwd,
    });
    if (denoIndex !== null) {
      return unwrapped.baseIndex + denoIndex;
    }
  }
  if (executable === "ruby" && hasRubyUnsafeApprovalFlag(unwrapped.argv)) {
    return null;
  }
  if (executable === "perl" && hasPerlUnsafeApprovalFlag(unwrapped.argv)) {
    return null;
  }
  if (!isMutableScriptRunner(executable)) {
    return null;
  }
  const genericIndex = resolveGenericInterpreterScriptOperandIndex({
    argv: unwrapped.argv,
    cwd,
    optionsWithFileValue:
      executable === "node" || executable === "nodejs" ? NODE_OPTIONS_WITH_FILE_VALUE : undefined,
  });
  return genericIndex === null ? null : unwrapped.baseIndex + genericIndex;
}

function shellPayloadNeedsStableBinding(shellCommand: string, cwd: string | undefined): boolean {
  const argv = splitShellArgs(shellCommand);
  if (!argv || argv.length === 0) {
    return false;
  }
  const snapshot = resolveMutableFileOperandSnapshotSync({
    argv,
    cwd,
    shellCommand: null,
  });
  if (!snapshot.ok) {
    return true;
  }
  if (snapshot.snapshot) {
    return true;
  }
  const firstToken = readTrimmedArgToken(argv, 0);
  if (!resolvesToExistingFileSync(firstToken, cwd)) {
    return false;
  }
  if (!path.isAbsolute(firstToken)) {
    return true;
  }
  const resolvedPath = path.resolve(cwd ?? process.cwd(), firstToken);
  if (pathLooksMutableForShellPayloadSync(resolvedPath)) {
    return true;
  }
  return isLikelyScriptLikePathSync(resolvedPath);
}

function requiresStableInterpreterApprovalBindingWithShellCommand(params: {
  argv: string[];
  shellCommand: string | null;
  cwd: string | undefined;
}): boolean {
  const unwrapped = unwrapArgvForMutableOperand(params.argv);
  if (unwrapped.opaqueMultiplexerSeen) {
    return true;
  }
  if (params.shellCommand !== null) {
    return shellPayloadNeedsStableBinding(params.shellCommand, params.cwd);
  }
  if (pnpmDlxInvocationNeedsFailClosedBinding(params.argv, params.cwd)) {
    return true;
  }
  const executable = normalizeExecutableToken(unwrapped.argv[0] ?? "");
  if (!executable) {
    return false;
  }
  if ((POSIX_SHELL_WRAPPERS as ReadonlySet<string>).has(executable)) {
    return false;
  }
  return isMutableScriptRunner(executable);
}

function pnpmDlxInvocationNeedsFailClosedBinding(argv: string[], cwd: string | undefined): boolean {
  if (normalizePackageManagerExecToken(argv[0] ?? "") !== "pnpm") {
    return false;
  }

  let idx = 1;
  while (idx < argv.length) {
    const token = readTrimmedArgToken(argv, idx);
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "--") {
      idx += 1;
      continue;
    }
    if (!token.startsWith("-")) {
      if (token !== "dlx") {
        return false;
      }
      return pnpmDlxTailNeedsFailClosedBinding(argv.slice(idx + 1), cwd);
    }
    const parsedOption = parseInlineOptionToken(token);
    const flag = normalizeLowercaseStringOrEmpty(parsedOption.name);
    if (PNPM_OPTIONS_WITH_VALUE.has(flag) || PNPM_DLX_OPTIONS_WITH_VALUE.has(flag)) {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    if (PNPM_CASE_SENSITIVE_OPTIONS_WITH_VALUE.has(parsedOption.name)) {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    if (PNPM_FLAG_OPTIONS.has(flag)) {
      idx += 1;
      continue;
    }
    return true;
  }

  return false;
}

function pnpmDlxTailNeedsFailClosedBinding(argv: string[], cwd: string | undefined): boolean {
  let idx = 0;
  while (idx < argv.length) {
    const token = readTrimmedArgToken(argv, idx);
    if (!token) {
      idx += 1;
      continue;
    }
    if (token === "--") {
      return pnpmDlxTailMayNeedStableBinding(argv.slice(idx + 1), cwd);
    }
    if (!token.startsWith("-")) {
      return pnpmDlxTailMayNeedStableBinding(argv.slice(idx), cwd);
    }
    const parsedOption = parseInlineOptionToken(token);
    const flag = normalizeLowercaseStringOrEmpty(parsedOption.name);
    if (flag === "-c" || flag === "--shell-mode") {
      return false;
    }
    if (PNPM_OPTIONS_WITH_VALUE.has(flag) || PNPM_DLX_OPTIONS_WITH_VALUE.has(flag)) {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    if (PNPM_CASE_SENSITIVE_OPTIONS_WITH_VALUE.has(parsedOption.name)) {
      idx += token.includes("=") ? 1 : 2;
      continue;
    }
    if (PNPM_FLAG_OPTIONS.has(flag)) {
      idx += 1;
      continue;
    }
    return true;
  }

  return true;
}

function pnpmDlxTailMayNeedStableBinding(argv: string[], cwd: string | undefined): boolean {
  const snapshot = resolveMutableFileOperandSnapshotSync({
    argv,
    cwd,
    shellCommand: null,
  });
  return snapshot.ok && snapshot.snapshot !== null;
}

/** Captures file identity for a mutable script operand that approval is bound to. */
export function resolveMutableFileOperandSnapshotSync(params: {
  argv: string[];
  cwd: string | undefined;
  shellCommand: string | null;
}): { ok: true; snapshot: SystemRunApprovalFileOperand | null } | { ok: false; message: string } {
  const argvIndex = resolveMutableFileOperandIndex(params.argv, params.cwd);
  if (argvIndex === null) {
    if (
      requiresStableInterpreterApprovalBindingWithShellCommand({
        argv: params.argv,
        shellCommand: params.shellCommand,
        cwd: params.cwd,
      })
    ) {
      return {
        ok: false,
        message: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
      };
    }
    return { ok: true, snapshot: null };
  }
  const rawOperand = readTrimmedArgToken(params.argv, argvIndex);
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

/** Rechecks that the approved cwd still points at the same directory identity. */
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

  const pinnedExecutable =
    resolution?.execution.resolvedRealPath ?? resolution?.execution.resolvedPath;
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
  if (command.shellPayload === null && isBlockedShellWrapperCommand(command.argv)) {
    return {
      ok: false,
      message: "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command",
    };
  }
  const materializedInlineEval = materializeInlineEvalForApprovalSync(
    command.argv,
    normalizeNullableString(params.cwd) ?? undefined,
  );
  if (!materializedInlineEval.ok) {
    return { ok: false, message: materializedInlineEval.message };
  }
  const approvalArgv = materializedInlineEval.command?.argv ?? command.argv;
  const hardening = hardenApprovedExecutionPaths({
    approvedByAsk: true,
    argv: approvalArgv,
    shellCommand: command.shellPayload,
    cwd: normalizeNullableString(params.cwd) ?? undefined,
  });
  if (!hardening.ok) {
    return { ok: false, message: hardening.message };
  }
  const commandText = formatExecCommand(hardening.argv);
  const commandPreview =
    materializedInlineEval.command !== null
      ? command.commandText
      : command.previewText?.trim() && command.previewText.trim() !== commandText
        ? command.previewText.trim()
        : null;
  const mutableFileOperand = resolveMutableFileOperandSnapshotSync({
    argv: hardening.argv,
    cwd: hardening.cwd,
    shellCommand: command.shellPayload,
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
      agentId: normalizeNullableString(params.agentId),
      sessionKey: normalizeNullableString(params.sessionKey),
      mutableFileOperand: mutableFileOperand.snapshot ?? undefined,
    },
  };
}
