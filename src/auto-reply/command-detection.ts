import type { OpenClawConfig } from "../config/types.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import { listChatCommands, listChatCommandsForConfig } from "./commands-registry-list.js";
import { normalizeCommandBody } from "./commands-registry-normalize.js";
import type { CommandNormalizeOptions } from "./commands-registry.types.js";
import { isAbortTrigger } from "./reply/abort-primitives.js";
import { stripInboundMetadata } from "./reply/strip-inbound-meta.js";

/**
 * 检查文本是否包含控制命令
 * @param text - 要检查的文本
 * @param cfg - OpenClaw配置
 * @param options - 命令规范化选项
 * @returns 是否包含控制命令
 */
export function hasControlCommand(
  text?: string,
  cfg?: OpenClawConfig,
  options?: CommandNormalizeOptions,
): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const stripped = stripInboundMetadata(trimmed);
  if (!stripped) {
    return false;
  }
  const normalizedBody = normalizeCommandBody(stripped, options);
  if (!normalizedBody) {
    return false;
  }
  const lowered = normalizeLowercaseStringOrEmpty(normalizedBody);
  const commands = cfg ? listChatCommandsForConfig(cfg) : listChatCommands();
  for (const command of commands) {
    for (const alias of command.textAliases) {
      const normalized = normalizeOptionalLowercaseString(alias);
      if (!normalized) {
        continue;
      }
      if (lowered === normalized) {
        return true;
      }
      if (command.acceptsArgs && lowered.startsWith(normalized)) {
        const nextChar = normalizedBody.charAt(normalized.length);
        if (nextChar && /\s/.test(nextChar)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * 检查消息是否为控制命令消息
 * @param text - 要检查的文本
 * @param cfg - OpenClaw配置
 * @param options - 命令规范化选项
 * @returns 是否为控制命令消息
 */
export function isControlCommandMessage(
  text?: string,
  cfg?: OpenClawConfig,
  options?: CommandNormalizeOptions,
): boolean {
  if (!text) {
    return false;
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (hasControlCommand(trimmed, cfg, options)) {
    return true;
  }
  const stripped = stripInboundMetadata(trimmed);
  const normalized =
    normalizeOptionalLowercaseString(normalizeCommandBody(stripped, options)) ?? "";
  return isAbortTrigger(normalized);
}

/**
 * 粗略检测内联指令/快捷方式（如"hey /status"）
 * 用于通道监视器决定是否为消息计算CommandAuthorized
 *
 * 此函数故意偏向假阳性；CommandAuthorized仅控制
 * 命令/指令执行，不控制正常聊天回复
 */
export function hasInlineCommandTokens(text?: string): boolean {
  const body = text ?? "";
  if (!body.trim()) {
    return false;
  }
  return /(?:^|\s)[/!][a-z]/i.test(body);
}

/**
 * 判断是否应计算CommandAuthorized
 * @param text - 要检查的文本
 * @param cfg - OpenClaw配置
 * @param options - 命令规范化选项
 * @returns 是否应计算授权
 */
export function shouldComputeCommandAuthorized(
  text?: string,
  cfg?: OpenClawConfig,
  options?: CommandNormalizeOptions,
): boolean {
  return isControlCommandMessage(text, cfg, options) || hasInlineCommandTokens(text);
}
