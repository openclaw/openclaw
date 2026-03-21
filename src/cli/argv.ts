import { isBunRuntime, isNodeRuntime } from "../daemon/runtime-binary.js";
import {
  consumeRootOptionToken,
  FLAG_TERMINATOR,
  isValueToken,
} from "../infra/cli-root-options.js";
import { normalizeCommand, normalizeOption } from "./program/command-aliases.js";

// 帮助标志集合 / Help flags set
const HELP_FLAGS = new Set(["-h", "--help"]);
// 版本标志集合 / Version flags set
const VERSION_FLAGS = new Set(["-V", "--version"]);
// 根版本别名标志 / Root version alias flag
const ROOT_VERSION_ALIAS_FLAG = "-v";

/**
 * 检查参数是否包含帮助或版本标志 / Check if arguments contain help or version flags
 * @param argv - 命令行参数数组 / Command line argument array
 * @returns 是否包含帮助或版本标志 / Whether contains help or version flags
 */
export function hasHelpOrVersion(argv: string[]): boolean {
  return (
    argv.some((arg) => HELP_FLAGS.has(arg) || VERSION_FLAGS.has(arg)) || hasRootVersionAlias(argv)
  );
}

/**
 * 解析正整数 / Parse positive integer
 * @param value - 字符串值 / String value
 * @returns 正整数或 undefined / Positive integer or undefined
 */
function parsePositiveInt(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

/**
 * 检查参数中是否包含指定标志 / Check if arguments contain specified flag
 * @param argv - 命令行参数数组 / Command line argument array
 * @param name - 标志名称 / Flag name
 * @returns 是否包含该标志 / Whether contains the flag
 */
export function hasFlag(argv: string[], name: string): boolean {
  const args = argv.slice(2);
  for (const arg of args) {
    if (arg === FLAG_TERMINATOR) {
      break;
    }
    // 应用选项规范化 / Apply option normalization
    const normalizedArg = normalizeOption(arg);
    if (normalizedArg === name) {
      return true;
    }
  }
  return false;
}

export function hasRootVersionAlias(argv: string[]): boolean {
  const args = argv.slice(2);
  let hasAlias = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      continue;
    }
    if (arg === FLAG_TERMINATOR) {
      break;
    }
    if (arg === ROOT_VERSION_ALIAS_FLAG) {
      hasAlias = true;
      continue;
    }
    const consumed = consumeRootOptionToken(args, i);
    if (consumed > 0) {
      i += consumed - 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    return false;
  }
  return hasAlias;
}

export function isRootVersionInvocation(argv: string[]): boolean {
  return isRootInvocationForFlags(argv, VERSION_FLAGS, { includeVersionAlias: true });
}

function isRootInvocationForFlags(
  argv: string[],
  targetFlags: Set<string>,
  options?: { includeVersionAlias?: boolean },
): boolean {
  const args = argv.slice(2);
  let hasTarget = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      continue;
    }
    if (arg === FLAG_TERMINATOR) {
      break;
    }
    if (
      targetFlags.has(arg) ||
      (options?.includeVersionAlias === true && arg === ROOT_VERSION_ALIAS_FLAG)
    ) {
      hasTarget = true;
      continue;
    }
    const consumed = consumeRootOptionToken(args, i);
    if (consumed > 0) {
      i += consumed - 1;
      continue;
    }
    // Unknown flags and subcommand-scoped help/version should fall back to Commander.
    return false;
  }
  return hasTarget;
}

export function isRootHelpInvocation(argv: string[]): boolean {
  return isRootInvocationForFlags(argv, HELP_FLAGS);
}

/**
 * 获取标志值 / Get flag value
 * @param argv - 命令行参数数组 / Command line argument array
 * @param name - 标志名称 / Flag name
 * @returns 标志值 / Flag value
 */
export function getFlagValue(argv: string[], name: string): string | null | undefined {
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === FLAG_TERMINATOR) {
      break;
    }
    // 应用选项规范化 / Apply option normalization
    const normalizedArg = normalizeOption(arg);
    if (normalizedArg === name) {
      const next = args[i + 1];
      return isValueToken(next) ? next : null;
    }
    if (normalizedArg.startsWith(`${name}=`)) {
      const value = normalizedArg.slice(name.length + 1);
      return value ? value : null;
    }
  }
  return undefined;
}

export function getVerboseFlag(argv: string[], options?: { includeDebug?: boolean }): boolean {
  if (hasFlag(argv, "--verbose")) {
    return true;
  }
  if (options?.includeDebug && hasFlag(argv, "--debug")) {
    return true;
  }
  return false;
}

export function getPositiveIntFlagValue(argv: string[], name: string): number | null | undefined {
  const raw = getFlagValue(argv, name);
  if (raw === null || raw === undefined) {
    return raw;
  }
  return parsePositiveInt(raw);
}

/**
 * 获取命令路径 / Get command path
 * @param argv - 命令行参数数组 / Command line argument array
 * @param depth - 命令深度 / Command depth
 * @returns 命令路径数组 / Command path array
 */
export function getCommandPath(argv: string[], depth = 2): string[] {
  return getCommandPathInternal(argv, depth, { skipRootOptions: false });
}

/**
 * 获取命令路径（跳过根选项）/ Get command path with root options
 * @param argv - 命令行参数数组 / Command line argument array
 * @param depth - 命令深度 / Command depth
 * @returns 命令路径数组 / Command path array
 */
export function getCommandPathWithRootOptions(argv: string[], depth = 2): string[] {
  return getCommandPathInternal(argv, depth, { skipRootOptions: true });
}

/**
 * 内部函数：获取命令路径 / Internal function: get command path
 * @param argv - 命令行参数数组 / Command line argument array
 * @param depth - 命令深度 / Command depth
 * @param opts - 选项 / Options
 * @returns 命令路径数组 / Command path array
 */
function getCommandPathInternal(
  argv: string[],
  depth: number,
  opts: { skipRootOptions: boolean },
): string[] {
  const args = argv.slice(2);
  const path: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      break;
    }
    if (opts.skipRootOptions) {
      const consumed = consumeRootOptionToken(args, i);
      if (consumed > 0) {
        i += consumed - 1;
        continue;
      }
    }
    if (arg.startsWith("-")) {
      continue;
    }
    // 应用命令规范化 / Apply command normalization
    path.push(normalizeCommand(arg));
    if (path.length >= depth) {
      break;
    }
  }
  return path;
}

/**
 * 获取主命令 / Get primary command
 * @param argv - 命令行参数数组 / Command line argument array
 * @returns 主命令名称或 null / Primary command name or null
 */
export function getPrimaryCommand(argv: string[]): string | null {
  const [primary] = getCommandPathWithRootOptions(argv, 1);
  // 应用命令规范化 / Apply command normalization
  return primary ? normalizeCommand(primary) : null;
}

type CommandPositionalsParseOptions = {
  commandPath: ReadonlyArray<string>;
  booleanFlags?: ReadonlyArray<string>;
  valueFlags?: ReadonlyArray<string>;
};

function consumeKnownOptionToken(
  args: ReadonlyArray<string>,
  index: number,
  booleanFlags: ReadonlySet<string>,
  valueFlags: ReadonlySet<string>,
): number {
  const arg = args[index];
  if (!arg || arg === FLAG_TERMINATOR || !arg.startsWith("-")) {
    return 0;
  }

  const equalsIndex = arg.indexOf("=");
  const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);

  if (booleanFlags.has(flag)) {
    return equalsIndex === -1 ? 1 : 0;
  }

  if (!valueFlags.has(flag)) {
    return 0;
  }

  if (equalsIndex !== -1) {
    const value = arg.slice(equalsIndex + 1).trim();
    return value ? 1 : 0;
  }

  return isValueToken(args[index + 1]) ? 2 : 0;
}

export function getCommandPositionalsWithRootOptions(
  argv: string[],
  options: CommandPositionalsParseOptions,
): string[] | null {
  const args = argv.slice(2);
  const commandPath = options.commandPath;
  const booleanFlags = new Set(options.booleanFlags ?? []);
  const valueFlags = new Set(options.valueFlags ?? []);
  const positionals: string[] = [];
  let commandIndex = 0;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg || arg === FLAG_TERMINATOR) {
      break;
    }

    const rootConsumed = consumeRootOptionToken(args, i);
    if (rootConsumed > 0) {
      i += rootConsumed - 1;
      continue;
    }

    if (arg.startsWith("-")) {
      const optionConsumed = consumeKnownOptionToken(args, i, booleanFlags, valueFlags);
      if (optionConsumed === 0) {
        return null;
      }
      i += optionConsumed - 1;
      continue;
    }

    if (commandIndex < commandPath.length) {
      if (arg !== commandPath[commandIndex]) {
        return null;
      }
      commandIndex += 1;
      continue;
    }

    positionals.push(arg);
  }

  if (commandIndex < commandPath.length) {
    return null;
  }
  return positionals;
}

export function buildParseArgv(params: {
  programName?: string;
  rawArgs?: string[];
  fallbackArgv?: string[];
}): string[] {
  const baseArgv =
    params.rawArgs && params.rawArgs.length > 0
      ? params.rawArgs
      : params.fallbackArgv && params.fallbackArgv.length > 0
        ? params.fallbackArgv
        : process.argv;
  const programName = params.programName ?? "";
  const normalizedArgv =
    programName && baseArgv[0] === programName
      ? baseArgv.slice(1)
      : baseArgv[0]?.endsWith("openclaw")
        ? baseArgv.slice(1)
        : baseArgv;
  const looksLikeNode =
    normalizedArgv.length >= 2 &&
    (isNodeRuntime(normalizedArgv[0] ?? "") || isBunRuntime(normalizedArgv[0] ?? ""));
  if (looksLikeNode) {
    return normalizedArgv;
  }
  return ["node", programName || "openclaw", ...normalizedArgv];
}

export function shouldMigrateStateFromPath(path: string[]): boolean {
  if (path.length === 0) {
    return true;
  }
  const [primary, secondary] = path;
  if (primary === "health" || primary === "status" || primary === "sessions") {
    return false;
  }
  if (primary === "update" && secondary === "status") {
    return false;
  }
  if (primary === "config" && (secondary === "get" || secondary === "unset")) {
    return false;
  }
  if (primary === "models" && (secondary === "list" || secondary === "status")) {
    return false;
  }
  if (primary === "memory" && secondary === "status") {
    return false;
  }
  if (primary === "agent") {
    return false;
  }
  return true;
}

export function shouldMigrateState(argv: string[]): boolean {
  return shouldMigrateStateFromPath(getCommandPath(argv, 2));
}
