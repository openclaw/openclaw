/**
 * 错误处理工具模块
 * 提供错误信息提取、格式化、类型守卫等功能
 */

import { redactSensitiveText } from "../logging/redact.js";

/**
 * 从错误对象中提取错误代码
 * 支持从任意对象中提取 code 属性，支持字符串和数字类型
 * @param err - 错误对象
 * @returns 错误代码字符串，如果无法提取则返回 undefined
 */
export function extractErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    return code;
  }
  if (typeof code === "number") {
    return String(code);
  }
  return undefined;
}

/**
 * 读取错误名称
 * 从错误对象中提取 name 属性
 * @param err - 错误对象
 * @returns 错误名称字符串
 */
export function readErrorName(err: unknown): string {
  if (!err || typeof err !== "object") {
    return "";
  }
  const name = (err as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

/**
 * 收集错误图中所有可能的候选错误
 * 用于遍历嵌套错误结构（如错误链）
 * @param err - 起始错误对象
 * @param resolveNested - 可选的函数，用于解析嵌套错误
 * @returns 错误候选数组
 */
export function collectErrorGraphCandidates(
  err: unknown,
  resolveNested?: (current: Record<string, unknown>) => Iterable<unknown>,
): unknown[] {
  const queue: unknown[] = [err];
  const seen = new Set<unknown>();
  const candidates: unknown[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current == null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    candidates.push(current);

    if (!current || typeof current !== "object" || !resolveNested) {
      continue;
    }
    for (const nested of resolveNested(current as Record<string, unknown>)) {
      if (nested != null && !seen.has(nested)) {
        queue.push(nested);
      }
    }
  }

  return candidates;
}

/**
 * 类型守卫：判断是否为 NodeJS.ErrnoException
 * 用于类型窄缩，检查错误是否具有 code 属性
 * @param err - 错误对象
 * @returns 是否为 NodeJS.ErrnoException
 */
export function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return Boolean(err && typeof err === "object" && "code" in err);
}

/**
 * 检查错误是否具有特定的 errno 代码
 * @param err - 错误对象
 * @param code - 要检查的错误代码
 * @returns 是否具有该错误代码
 */
export function hasErrnoCode(err: unknown, code: string): boolean {
  return isErrno(err) && err.code === code;
}

/**
 * 格式化错误消息
 * 将各种类型的错误对象转换为字符串格式
 * 支持 Error、字符串、数字、布尔值等
 * 会遍历错误链（.cause）以包含所有嵌套错误信息
 * @param err - 错误对象
 * @returns 格式化的错误消息字符串
 */
export function formatErrorMessage(err: unknown): string {
  let formatted: string;
  if (err instanceof Error) {
    formatted = err.message || err.name || "Error";
    // 遍历 .cause 链以包含嵌套错误消息（例如 grammY HttpError 在 .cause 中包装网络错误）
    let cause: unknown = err.cause;
    const seen = new Set<unknown>([err]);
    while (cause && !seen.has(cause)) {
      seen.add(cause);
      if (cause instanceof Error) {
        if (cause.message) {
          formatted += ` | ${cause.message}`;
        }
        cause = cause.cause;
      } else if (typeof cause === "string") {
        formatted += ` | ${cause}`;
        break;
      } else {
        break;
      }
    }
  } else if (typeof err === "string") {
    formatted = err;
  } else if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    formatted = String(err);
  } else {
    try {
      formatted = JSON.stringify(err);
    } catch {
      formatted = Object.prototype.toString.call(err);
    }
  }
  // 安全：返回前进行最佳效果的 token 脱敏
  return redactSensitiveText(formatted);
}
