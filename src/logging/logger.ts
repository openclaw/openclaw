// 引入 Node.js 文件系统、操作系统和路径模块
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// 引入 tslog 日志库
import { Logger as TsLogger } from "tslog";
import type { OpenClawConfig } from "../config/types.js";
// 引入诊断事件发射器
import { emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  isValidDiagnosticSpanId,
  isValidDiagnosticTraceFlags,
  isValidDiagnosticTraceId,
  type DiagnosticTraceContext,
} from "../infra/diagnostic-trace-context.js";
// 引入原型键安全检查
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import {
  POSIX_OPENCLAW_TMP_DIR,
  resolvePreferredOpenClawTmpDir,
} from "../infra/tmp-openclaw-dir.js";
// 引入日志配置和级别工具
import { readLoggingConfig, shouldSkipMutatingLoggingConfigRead } from "./config.js";
import { resolveEnvLogLevelOverride } from "./env-log-level.js";
import { type LogLevel, levelToMinLevel, normalizeLogLevel } from "./levels.js";
// 引入敏感信息脱敏
import { redactSensitiveText } from "./redact.js";
import { loggingState } from "./state.js";
import { formatTimestamp } from "./timestamps.js";
import type { LoggerSettings } from "./types.js";
// 导出日志设置类型
export type { LoggerSettings } from "./types.js";

// Node.js 进程的扩展类型，包含 getBuiltinModule 方法
type ProcessWithBuiltinModule = NodeJS.Process & {
  getBuiltinModule?: (id: string) => unknown;
};

/**
 * 检查是否可以使用 Node.js 原生 fs 模块
 * @returns 是否可用
 */
function canUseNodeFs(): boolean {
  const getBuiltinModule = (process as ProcessWithBuiltinModule).getBuiltinModule;
  if (typeof getBuiltinModule !== "function") {
    return false;
  }
  try {
    return getBuiltinModule("fs") !== undefined;
  } catch {
    return false;
  }
}

/**
 * 解析默认日志目录
 * @returns 日志目录路径
 */
function resolveDefaultLogDir(): string {
  return canUseNodeFs() ? resolvePreferredOpenClawTmpDir() : POSIX_OPENCLAW_TMP_DIR;
}

/**
 * 解析默认日志文件路径
 * @param defaultLogDir - 默认日志目录
 * @returns 日志文件路径
 */
function resolveDefaultLogFile(defaultLogDir: string): string {
  return canUseNodeFs()
    ? path.join(defaultLogDir, "openclaw.log")
    : `${POSIX_OPENCLAW_TMP_DIR}/openclaw.log`;
}

// 导出的默认日志目录
export const DEFAULT_LOG_DIR = resolveDefaultLogDir();
// 导出的默认日志文件路径
export const DEFAULT_LOG_FILE = resolveDefaultLogFile(DEFAULT_LOG_DIR); // legacy single-file path

// 日志文件名前缀和后缀
const LOG_PREFIX = "openclaw";
const LOG_SUFFIX = ".log";
// 日志文件最大保留时间：24小时
const MAX_LOG_AGE_MS = 24 * 60 * 60 * 1000; // 24h
// 默认最大日志文件大小：100MB
const DEFAULT_MAX_LOG_FILE_BYTES = 100 * 1024 * 1024; // 100 MB
// 最大轮转日志文件数量
const MAX_ROTATED_LOG_FILES = 5;

// 日志对象类型
type LogObj = { date?: Date } & Record<string, unknown>;

// 已解析的设置类型
type ResolvedSettings = {
  level: LogLevel;       // 日志级别
  file: string;          // 日志文件路径
  maxFileBytes: number;  // 最大文件字节数
};
// 导出的已解析设置类型
export type LoggerResolvedSettings = ResolvedSettings;
type TsLogRecord = Record<string, unknown>;

// 诊断日志代码信息
type DiagnosticLogCode = {
  line?: number;          // 代码行号
  functionName?: string;  // 函数名
};

// 诊断日志属性相关常量
const MAX_DIAGNOSTIC_LOG_BINDINGS_JSON_CHARS = 8 * 1024;
const MAX_DIAGNOSTIC_LOG_MESSAGE_CHARS = 4 * 1024;
const MAX_DIAGNOSTIC_LOG_ATTRIBUTE_COUNT = 32;
const MAX_DIAGNOSTIC_LOG_ATTRIBUTE_VALUE_CHARS = 2 * 1024;
const MAX_DIAGNOSTIC_LOG_NAME_CHARS = 120;
const MAX_FILE_LOG_MESSAGE_CHARS = 4 * 1024;
const MAX_FILE_LOG_CONTEXT_VALUE_CHARS = 512;
// 诊断日志属性名正则：字母数字下划线点和冒号，1-64字符
const DIAGNOSTIC_LOG_ATTRIBUTE_KEY_RE = /^[A-Za-z0-9_.:-]{1,64}$/u;
// 主机名
const HOSTNAME = os.hostname() || "unknown";

// 诊断日志属性类型
type DiagnosticLogAttributes = Record<string, string | number | boolean>;

/**
 * 截断诊断日志文本到指定最大字符数
 * @param value - 原始值
 * @param maxChars - 最大字符数
 * @returns 截断后的文本
 */
function clampDiagnosticLogText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...(truncated)` : value;
}

/**
 * 清理并截断诊断日志文本
 * 先脱敏再截断
 * @param value - 原始值
 * @param maxChars - 最大字符数
 * @returns 清理后的文本
 */
function sanitizeDiagnosticLogText(value: string, maxChars: number): string {
  return clampDiagnosticLogText(
    redactSensitiveText(clampDiagnosticLogText(value, maxChars)),
    maxChars,
  );
}

/**
 * 规范化诊断日志名称
 * @param value - 原始名称
 * @returns 规范化后的名称或 undefined
 */
function normalizeDiagnosticLogName(value: string | undefined): string | undefined {
  // 空值或以 { 开头无效
  if (!value || value.trim().startsWith("{")) {
    return undefined;
  }
  const sanitized = sanitizeDiagnosticLogText(value.trim(), MAX_DIAGNOSTIC_LOG_NAME_CHARS);
  return DIAGNOSTIC_LOG_ATTRIBUTE_KEY_RE.test(sanitized) ? sanitized : undefined;
}

/**
 * 分配诊断日志属性
 * @param attributes - 属性对象
 * @param state - 状态计数器
 * @param key - 属性键
 * @param value - 属性值
 */
function assignDiagnosticLogAttribute(
  attributes: DiagnosticLogAttributes,
  state: { count: number },
  key: string,
  value: unknown,
): void {
  // 超过最大属性数量则忽略
  if (state.count >= MAX_DIAGNOSTIC_LOG_ATTRIBUTE_COUNT) {
    return;
  }
  const normalizedKey = key.trim();
  // 阻止原型键
  if (isBlockedObjectKey(normalizedKey)) {
    return;
  }
  // 脱敏后键变化则忽略
  if (redactSensitiveText(normalizedKey) !== normalizedKey) {
    return;
  }
  // 键格式验证
  if (!DIAGNOSTIC_LOG_ATTRIBUTE_KEY_RE.test(normalizedKey)) {
    return;
  }
  // 字符串值
  if (typeof value === "string") {
    attributes[normalizedKey] = sanitizeDiagnosticLogText(
      value,
      MAX_DIAGNOSTIC_LOG_ATTRIBUTE_VALUE_CHARS,
    );
    state.count += 1;
    return;
  }
  // 有限数值
  if (typeof value === "number" && Number.isFinite(value)) {
    attributes[normalizedKey] = value;
    state.count += 1;
    return;
  }
  // 布尔值
  if (typeof value === "boolean") {
    attributes[normalizedKey] = value;
    state.count += 1;
  }
}

/**
 * 从源对象添加诊断日志属性
 * @param attributes - 属性对象
 * @param state - 状态计数器
 * @param source - 源对象
 */
function addDiagnosticLogAttributesFrom(
  attributes: DiagnosticLogAttributes,
  state: { count: number },
  source: Record<string, unknown> | undefined,
): void {
  if (!source) {
    return;
  }
  for (const key in source) {
    if (state.count >= MAX_DIAGNOSTIC_LOG_ATTRIBUTE_COUNT) {
      break;
    }
    // 跳过原型链属性和 trace 字段
    if (!Object.hasOwn(source, key) || key === "trace") {
      continue;
    }
    assignDiagnosticLogAttribute(attributes, state, key, source[key]);
  }
}

/**
 * 检查是否为普通日志记录对象
 * @param value - 待检查值
 * @returns 是否为普通对象
 */
function isPlainLogRecordObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * 规范化跟踪上下文
 * @param value - 原始值
 * @returns 诊断跟踪上下文或 undefined
 */
function normalizeTraceContext(value: unknown): DiagnosticTraceContext | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<DiagnosticTraceContext>;
  // 验证跟踪 ID
  if (!isValidDiagnosticTraceId(candidate.traceId)) {
    return undefined;
  }
  // 验证跨度 ID
  if (candidate.spanId !== undefined && !isValidDiagnosticSpanId(candidate.spanId)) {
    return undefined;
  }
  // 验证父跨度 ID
  if (candidate.parentSpanId !== undefined && !isValidDiagnosticSpanId(candidate.parentSpanId)) {
    return undefined;
  }
  // 验证跟踪标志
  if (candidate.traceFlags !== undefined && !isValidDiagnosticTraceFlags(candidate.traceFlags)) {
    return undefined;
  }
  return {
    traceId: candidate.traceId,
    ...(candidate.spanId ? { spanId: candidate.spanId } : {}),
    ...(candidate.parentSpanId ? { parentSpanId: candidate.parentSpanId } : {}),
    ...(candidate.traceFlags ? { traceFlags: candidate.traceFlags } : {}),
  };
}

/**
 * 从值中提取跟踪上下文
 * @param value - 原始值
 * @returns 诊断跟踪上下文或 undefined
 */
function extractTraceContext(value: unknown): DiagnosticTraceContext | undefined {
  // 先尝试直接提取
  const direct = normalizeTraceContext(value);
  if (direct) {
    return direct;
  }
  // 从 trace 属性提取
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return normalizeTraceContext((value as { trace?: unknown }).trace);
}

/**
 * 获取排序的数字日志参数
 * @param logObj - 日志对象
 * @returns 排序后的参数数组
 */
function getSortedNumericLogArgs(logObj: TsLogRecord): unknown[] {
  return Object.entries(logObj)
    .filter(([key]) => /^\d+$/.test(key)) // 只保留数字键
    .toSorted((a, b) => Number(a[0]) - Number(b[0])) // 按数字排序
    .map(([, value]) => value); // 提取值
}

/**
 * 截断文件日志文本
 * @param value - 原始值
 * @param maxChars - 最大字符数
 * @returns 截断后的文本
 */
function clampFileLogText(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...(truncated)` : value;
}

/**
 * 规范化文件日志上下文值
 * @param value - 原始值
 * @returns 规范化后的字符串或 undefined
 */
function normalizeFileLogContextValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? clampFileLogText(normalized, MAX_FILE_LOG_CONTEXT_VALUE_CHARS) : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

/**
 * 从多个源读取第一个上下文字符串
 * @param sources - 源对象数组
 * @param keys - 要查找的键数组
 * @returns 找到的第一个字符串值或 undefined
 */
function readFirstContextString(
  sources: Array<Record<string, unknown> | undefined>,
  keys: readonly string[],
): string | undefined {
  for (const source of sources) {
    if (!source) {
      continue;
    }
    for (const key of keys) {
      const value = normalizeFileLogContextValue(source[key]);
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

/**
 * 序列化文件日志消息部分
 * @param value - 值
 * @returns 序列化字符串或 undefined
 */
function stringifyFileLogMessagePart(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Error) {
    return value.message || value.name;
  }
  if (isPlainLogRecordObject(value) && typeof value.message === "string") {
    return value.message;
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * 构建文件日志消息
 * @param numericArgs - 数字参数数组
 * @returns 构建的消息或 undefined
 */
function buildFileLogMessage(numericArgs: readonly unknown[]): string | undefined {
  const parts = numericArgs
    .map(stringifyFileLogMessagePart) // 序列化每个部分
    .filter((part): part is string => Boolean(part && part.trim())); // 过滤空值
  if (parts.length === 0) {
    return undefined;
  }
  return clampFileLogText(parts.join(" "), MAX_FILE_LOG_MESSAGE_CHARS);
}

/**
 * 提取日志绑定前缀
 * @param numericArgs - 数字参数数组
 * @returns 包含绑定和参数的元组
 */
function extractLogBindingPrefix(numericArgs: unknown[]): {
  bindings?: Record<string, unknown>;
  args: unknown[];
} {
  // 检查第一个参数是否为 JSON 绑定
  if (
    typeof numericArgs[0] === "string" &&
    numericArgs[0].length <= MAX_DIAGNOSTIC_LOG_BINDINGS_JSON_CHARS &&
    numericArgs[0].trim().startsWith("{")
  ) {
    try {
      const parsed = JSON.parse(numericArgs[0]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          bindings: parsed as Record<string, unknown>,
          args: numericArgs.slice(1), // 剩余参数
        };
      }
    } catch {
      // 忽略格式错误的 JSON
    }
  }
  return { args: numericArgs };
}

/**
 * 查找日志跟踪上下文
 * @param bindings - 绑定对象
 * @param numericArgs - 数字参数数组
 * @returns 跟踪上下文或 undefined
 */
function findLogTraceContext(
  bindings: Record<string, unknown> | undefined,
  numericArgs: readonly unknown[],
): DiagnosticTraceContext | undefined {
  // 从绑定中提取
  const fromBindings = extractTraceContext(bindings);
  if (fromBindings) {
    return fromBindings;
  }
  // 从参数中提取
  for (const arg of numericArgs) {
    const fromArg = extractTraceContext(arg);
    if (fromArg) {
      return fromArg;
    }
  }
  return undefined;
}

/**
 * 构建跟踪文件日志字段
 * @param logObj - 日志对象
 * @returns 跟踪字段对象或 undefined
 */
function buildTraceFileLogFields(logObj: TsLogRecord): Record<string, string> | undefined {
  const { bindings, args } = extractLogBindingPrefix(getSortedNumericLogArgs(logObj));
  const trace = findLogTraceContext(bindings, args) ?? getActiveDiagnosticTraceContext();
  if (!trace) {
    return undefined;
  }
  return {
    traceId: trace.traceId,
    ...(trace.spanId ? { spanId: trace.spanId } : {}),
    ...(trace.parentSpanId ? { parentSpanId: trace.parentSpanId } : {}),
    ...(trace.traceFlags ? { traceFlags: trace.traceFlags } : {}),
  };
}

/**
 * 构建结构化文件日志字段
 * @param logObj - 日志对象
 * @returns 结构化字段对象
 */
function buildStructuredFileLogFields(logObj: TsLogRecord): Record<string, string> {
  const { bindings, args } = extractLogBindingPrefix(getSortedNumericLogArgs(logObj));
  // 第一个参数是否为结构化对象
  const structuredArg = isPlainLogRecordObject(args[0]) ? args[0] : undefined;
  const sources = [structuredArg, bindings, logObj];
  // 构建消息参数
  const messageArgs =
    structuredArg && typeof structuredArg.message !== "string" ? args.slice(1) : args;
  const message = buildFileLogMessage(messageArgs);
  // 读取上下文字段
  const agentId = readFirstContextString(sources, ["agent_id", "agentId"]);
  const sessionId = readFirstContextString(sources, ["session_id", "sessionId", "sessionKey"]);
  const channel = readFirstContextString(sources, ["channel", "messageProvider"]);
  return {
    hostname: HOSTNAME,
    ...(message ? { message } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(channel ? { channel } : {}),
  };
}

/**
 * 构建诊断日志记录
 * @param logObj - 日志对象
 * @returns 诊断日志记录对象
 */
function buildDiagnosticLogRecord(logObj: TsLogRecord) {
  const meta = logObj._meta as
    | {
        logLevelName?: string;
        date?: Date;
        name?: string;
        parentNames?: string[];
        path?: {
          filePath?: string;
          fileLine?: string;
          fileColumn?: string;
          filePathWithLine?: string;
          method?: string;
        };
      }
    | undefined;
  const { bindings, args: numericArgs } = extractLogBindingPrefix(getSortedNumericLogArgs(logObj));

  // 获取跟踪上下文
  const trace = findLogTraceContext(bindings, numericArgs) ?? getActiveDiagnosticTraceContext();
  const structuredArg = numericArgs[0];
  const structuredBindings = isPlainLogRecordObject(structuredArg) ? structuredArg : undefined;
  if (structuredBindings) {
    numericArgs.shift();
  }

  // 构建消息
  let message = "";
  if (numericArgs.length > 0 && typeof numericArgs[numericArgs.length - 1] === "string") {
    message = sanitizeDiagnosticLogText(
      String(numericArgs.pop()),
      MAX_DIAGNOSTIC_LOG_MESSAGE_CHARS,
    );
  } else if (
    numericArgs.length === 1 &&
    (typeof numericArgs[0] === "number" || typeof numericArgs[0] === "boolean")
  ) {
    message = String(numericArgs[0]);
    numericArgs.length = 0;
  }
  if (!message) {
    message = "log";
  }

  // 构建属性
  const attributes: DiagnosticLogAttributes = Object.create(null) as DiagnosticLogAttributes;
  const attributeState = { count: 0 };
  addDiagnosticLogAttributesFrom(attributes, attributeState, bindings);
  addDiagnosticLogAttributesFrom(attributes, attributeState, structuredBindings);

  // 构建代码位置信息
  const code: DiagnosticLogCode = {};
  if (meta?.path?.fileLine) {
    const line = Number(meta.path.fileLine);
    if (Number.isFinite(line)) {
      code.line = line;
    }
  }
  if (meta?.path?.method) {
    code.functionName = sanitizeDiagnosticLogText(meta.path.method, MAX_DIAGNOSTIC_LOG_NAME_CHARS);
  }

  // 规范化日志器名称
  const loggerName = normalizeDiagnosticLogName(meta?.name);
  const loggerParents = meta?.parentNames
    ?.map(normalizeDiagnosticLogName)
    .filter((name): name is string => Boolean(name));

  return {
    type: "log.record" as const,
    level: meta?.logLevelName ?? "INFO",
    message,
    ...(loggerName ? { loggerName } : {}),
    ...(loggerParents?.length ? { loggerParents } : {}),
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(Object.keys(code).length > 0 ? { code } : {}),
    ...(trace ? { trace } : {}),
  };
}

/**
 * 附加诊断事件传输
 * @param logger - 日志器实例
 */
function attachDiagnosticEventTransport(logger: TsLogger<LogObj>): void {
  logger.attachTransport((logObj: LogObj) => {
    try {
      // 发射诊断事件
      emitDiagnosticEvent(buildDiagnosticLogRecord(logObj as TsLogRecord));
    } catch {
      // 日志失败永不阻塞
    }
  });
}

/**
 * 检查是否可使用静默 Vitest 文件日志快速路径
 * @param envLevel - 环境级别
 * @returns 是否可用
 */
function canUseSilentVitestFileLogFastPath(envLevel: LogLevel | undefined): boolean {
  return (
    process.env.VITEST === "true" &&
    process.env.OPENCLAW_TEST_FILE_LOG !== "1" &&
    !envLevel &&
    !loggingState.overrideSettings
  );
}

/**
 * 解析设置
 * @returns 已解析的设置
 */
function resolveSettings(): ResolvedSettings {
  // 无法使用 Node fs 时返回静默级别
  if (!canUseNodeFs()) {
    return {
      level: "silent",
      file: DEFAULT_LOG_FILE,
      maxFileBytes: DEFAULT_MAX_LOG_FILE_BYTES,
    };
  }

  const envLevel = resolveEnvLogLevelOverride();
  // 测试运行默认文件日志为静默，避免在启动时拉取重型配置
  if (canUseSilentVitestFileLogFastPath(envLevel)) {
    return {
      level: "silent",
      file: defaultRollingPathForToday(),
      maxFileBytes: DEFAULT_MAX_LOG_FILE_BYTES,
    };
  }

  // 读取配置
  const cfg: OpenClawConfig["logging"] | undefined =
    (loggingState.overrideSettings as LoggerSettings | null) ?? readLoggingConfig();
  // 测试环境默认静默
  const defaultLevel =
    process.env.VITEST === "true" && process.env.OPENCLAW_TEST_FILE_LOG !== "1" ? "silent" : "info";
  // 解析日志级别：环境变量优先，然后是配置，最后是默认值
  const fromConfig = normalizeLogLevel(cfg?.level, defaultLevel);
  const level = envLevel ?? fromConfig;
  const file = cfg?.file ?? defaultRollingPathForToday();
  const maxFileBytes = resolveMaxLogFileBytes(cfg?.maxFileBytes);
  return { level, file, maxFileBytes };
}

/**
 * 检查设置是否变更
 * @param a - 旧设置
 * @param b - 新设置
 * @returns 是否变更
 */
function settingsChanged(a: ResolvedSettings | null, b: ResolvedSettings) {
  if (!a) {
    return true;
  }
  return a.level !== b.level || a.file !== b.file || a.maxFileBytes !== b.maxFileBytes;
}

/**
 * 检查文件日志级别是否启用
 * @param level - 日志级别
 * @returns 是否启用
 */
export function isFileLogLevelEnabled(level: LogLevel): boolean {
  const settings = (loggingState.cachedSettings as ResolvedSettings | null) ?? resolveSettings();
  if (!loggingState.cachedSettings) {
    loggingState.cachedSettings = settings;
  }
  if (level === "silent") {
    return false;
  }
  if (settings.level === "silent") {
    return false;
  }
  // 检查级别是否足够高
  return levelToMinLevel(level) >= levelToMinLevel(settings.level);
}

/**
 * 构建日志器
 * @param settings - 已解析的设置
 * @returns TsLogger 实例
 */
function buildLogger(settings: ResolvedSettings): TsLogger<LogObj> {
  const logger = new TsLogger<LogObj>({
    name: "openclaw",
    minLevel: levelToMinLevel(settings.level),
    type: "hidden", // 无 ANSI 格式
  });

  // 静默日志不写文件，跳过文件系统设置
  if (settings.level === "silent") {
    attachDiagnosticEventTransport(logger);
    return logger;
  }

  // 检查是否为轮转路径
  const rollingFile = isRollingPath(settings.file);
  let activeFile = resolveActiveLogFile(settings.file);
  // 创建目录
  fs.mkdirSync(path.dirname(activeFile), { recursive: true });
  // 使用带日期的文件名时清理旧日志
  if (rollingFile) {
    pruneOldRollingLogs(path.dirname(activeFile));
  }
  let currentFileBytes = getCurrentLogFileBytes(activeFile);
  let warnedAboutRotationFailure = false;

  // 附加文件传输
  logger.attachTransport((logObj: LogObj) => {
    try {
      const nextActiveFile = resolveActiveLogFile(settings.file);
      // 文件路径变更（如日期切换）
      if (nextActiveFile !== activeFile) {
        activeFile = nextActiveFile;
        fs.mkdirSync(path.dirname(activeFile), { recursive: true });
        if (rollingFile) {
          pruneOldRollingLogs(path.dirname(activeFile));
        }
        currentFileBytes = getCurrentLogFileBytes(activeFile);
      }
      // 格式化时间戳
      const time = formatTimestamp(logObj.date ?? new Date(), { style: "long" });
      // 构建跟踪和结构化字段
      const traceFields = buildTraceFileLogFields(logObj as TsLogRecord);
      const structuredFields = buildStructuredFileLogFields(logObj as TsLogRecord);
      // 构建日志行
      const line = redactSensitiveText(
        JSON.stringify({ ...logObj, time, ...structuredFields, ...traceFields }),
      );
      const payload = `${line}\n`;
      const payloadBytes = Buffer.byteLength(payload, "utf8");
      const nextBytes = currentFileBytes + payloadBytes;
      // 检查是否需要轮转
      if (currentFileBytes > 0 && nextBytes > settings.maxFileBytes) {
        if (rotateLogFile(activeFile)) {
          currentFileBytes = getCurrentLogFileBytes(activeFile);
          warnedAboutRotationFailure = false;
        } else if (!warnedAboutRotationFailure) {
          warnedAboutRotationFailure = true;
          // 输出到 stderr
          process.stderr.write(
            `[openclaw] log file rotation failed; continuing writes file=${activeFile} maxFileBytes=${settings.maxFileBytes}\n`,
          );
        }
      }
      // 追加日志行
      if (appendLogLine(activeFile, payload)) {
        currentFileBytes += payloadBytes;
      }
    } catch {
      // 日志失败永不阻塞
    }
  });
  // 附加诊断事件传输
  attachDiagnosticEventTransport(logger);

  return logger;
}

/**
 * 解析最大日志文件字节数
 * @param raw - 原始值
 * @returns 解析后的字节数
 */
function resolveMaxLogFileBytes(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return DEFAULT_MAX_LOG_FILE_BYTES;
}

/**
 * 获取当前日志文件字节数
 * @param file - 文件路径
 * @returns 文件大小
 */
function getCurrentLogFileBytes(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/**
 * 追加日志行到文件
 * @param file - 文件路径
 * @param line - 日志行
 * @returns 是否成功
 */
function appendLogLine(file: string, line: string): boolean {
  try {
    fs.appendFileSync(file, line, { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

/**
 * 获取日志器
 * @returns TsLogger 实例
 */
export function getLogger(): TsLogger<LogObj> {
  const settings = resolveSettings();
  const cachedLogger = loggingState.cachedLogger as TsLogger<LogObj> | null;
  const cachedSettings = loggingState.cachedSettings as ResolvedSettings | null;
  // 设置变更时重新构建
  if (!cachedLogger || settingsChanged(cachedSettings, settings)) {
    loggingState.cachedLogger = buildLogger(settings);
    loggingState.cachedSettings = settings;
  }
  return loggingState.cachedLogger as TsLogger<LogObj>;
}

/**
 * 获取子日志器
 * @param bindings - 绑定对象
 * @param opts - 选项
 * @returns 子日志器
 */
export function getChildLogger(
  bindings?: Record<string, unknown>,
  opts?: { level?: LogLevel },
): TsLogger<LogObj> {
  const base = getLogger();
  const minLevel = opts?.level ? levelToMinLevel(opts.level) : base.settings.minLevel;
  const name = bindings ? JSON.stringify(bindings) : undefined;
  return base.getSubLogger({
    name,
    minLevel,
    prefix: bindings ? [name ?? ""] : [],
  });
}

// Baileys 期望 pino 风格的日志器形状，提供轻量适配器
/**
 * 转换为 pino 风格日志器
 * @param logger - TsLogger 实例
 * @param level - 日志级别
 * @returns Pino 风格日志器
 */
export function toPinoLikeLogger(logger: TsLogger<LogObj>, level: LogLevel): PinoLikeLogger {
  const buildChild = (bindings?: Record<string, unknown>) =>
    toPinoLikeLogger(
      logger.getSubLogger({
        name: bindings ? JSON.stringify(bindings) : undefined,
        minLevel: logger.settings.minLevel,
      }),
      level,
    );

  return {
    level,
    child: buildChild,
    trace: (...args: unknown[]) => logger.trace(...args),
    debug: (...args: unknown[]) => logger.debug(...args),
    info: (...args: unknown[]) => logger.info(...args),
    warn: (...args: unknown[]) => logger.warn(...args),
    error: (...args: unknown[]) => logger.error(...args),
    fatal: (...args: unknown[]) => logger.fatal(...args),
  };
}

// Pino 风格日志器类型
export type PinoLikeLogger = {
  level: string;
  child: (bindings?: Record<string, unknown>) => PinoLikeLogger;
  trace: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
};

/**
 * 获取已解析的日志器设置
 * @returns 已解析的设置
 */
export function getResolvedLoggerSettings(): LoggerResolvedSettings {
  return resolveSettings();
}

// 测试辅助函数
/**
 * 设置日志器覆盖
 * @param settings - 日志设置或 null
 */
export function setLoggerOverride(settings: LoggerSettings | null) {
  loggingState.overrideSettings = settings;
  loggingState.cachedLogger = null;
  loggingState.cachedSettings = null;
  loggingState.cachedConsoleSettings = null;
}

/**
 * 重置日志器
 */
export function resetLogger() {
  loggingState.cachedLogger = null;
  loggingState.cachedSettings = null;
  loggingState.cachedConsoleSettings = null;
  loggingState.overrideSettings = null;
}

// 导出测试辅助
export const __test__ = {
  shouldSkipMutatingLoggingConfigRead,
};

/**
 * 格式化本地日期
 * @param date - 日期对象
 * @returns YYYY-MM-DD 格式字符串
 */
function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 获取今天的默认轮转路径
 * @returns 轮转日志文件路径
 */
function defaultRollingPathForToday(): string {
  return rollingPathForDate(DEFAULT_LOG_DIR, new Date());
}

/**
 * 获取指定日期的轮转路径
 * @param dir - 目录
 * @param date - 日期
 * @returns 轮转日志文件路径
 */
function rollingPathForDate(dir: string, date: Date): string {
  const today = formatLocalDate(date);
  return path.join(dir, `${LOG_PREFIX}-${today}${LOG_SUFFIX}`);
}

/**
 * 解析活动日志文件（处理轮转）
 * @param file - 文件路径
 * @returns 实际文件路径
 */
function resolveActiveLogFile(file: string): string {
  if (!isRollingPath(file)) {
    return file;
  }
  return rollingPathForDate(path.dirname(file), new Date());
}

/**
 * 检查是否为轮转路径
 * @param file - 文件路径
 * @returns 是否为轮转路径
 */
function isRollingPath(file: string): boolean {
  const base = path.basename(file);
  return (
    base.startsWith(`${LOG_PREFIX}-`) &&
    base.endsWith(LOG_SUFFIX) &&
    base.length === `${LOG_PREFIX}-YYYY-MM-DD${LOG_SUFFIX}`.length
  );
}

/**
 * 清理旧的轮转日志
 * @param dir - 目录
 */
function pruneOldRollingLogs(dir: string): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const cutoff = Date.now() - MAX_LOG_AGE_MS;
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      // 检查是否为日志文件
      if (!entry.name.startsWith(`${LOG_PREFIX}-`) || !entry.name.endsWith(LOG_SUFFIX)) {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        // 删除超过最大保留时间的日志
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(fullPath, { force: true });
        }
      } catch {
        // 忽略删除错误
      }
    }
  } catch {
    // 忽略目录读取错误
  }
}

/**
 * 获取轮转日志路径
 * @param file - 原始文件路径
 * @param index - 轮转索引
 * @returns 轮转日志路径
 */
function rotatedLogPath(file: string, index: number): string {
  const ext = path.extname(file);
  const base = file.slice(0, file.length - ext.length);
  return `${base}.${index}${ext}`;
}

/**
 * 轮转日志文件
 * @param file - 文件路径
 * @returns 是否成功
 */
function rotateLogFile(file: string): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 删除最旧的轮转日志
    fs.rmSync(rotatedLogPath(file, MAX_ROTATED_LOG_FILES), { force: true });
    // 轮转现有日志
    for (let index = MAX_ROTATED_LOG_FILES - 1; index >= 1; index -= 1) {
      const from = rotatedLogPath(file, index);
      if (!fs.existsSync(from)) {
        continue;
      }
      fs.renameSync(from, rotatedLogPath(file, index + 1));
    }
    // 重命名当前日志为 .1
    if (fs.existsSync(file)) {
      fs.renameSync(file, rotatedLogPath(file, 1));
    }
    return true;
  } catch {
    return false;
  }
}
