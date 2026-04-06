/**
 * OpenClaw 工具结果结果自动压缩
 * 
 * 基于对 Claude Code 源码的分析，实现了 Microcompact 机制：
 * - Cache-based: 基于工具调用次数的压缩
 * - Time-based: 基于时间间隔的压缩
 * - 智能 Token 估算
 * 
 * 目的：减少上下文中的 Token 消耗，延长会话寿命
 * 
 * 创建时间: 2026-04-05
 * 优化时间: 2026-04-05 (日志优化、类型改进)
 */

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 工具结果的通用内容类型
 */
export type ToolResultContent = string | Buffer | Record<string, unknown> | unknown[];

/**
 * 消息块类型
 */
export type ContentBlock = 
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; id: string; input?: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content?: ToolResultContent }
  | { type: 'image'; source?: Record<string, unknown>; detail?: Record<string, unknown> }
  | { type: 'document'; source?: Record<string, unknown>; detail?: Record<string, unknown> };

/**
 * 消息内容类型
 */
export type MessageContent = ContentBlock[] | string;

/**
 * 消息接口
 */
export interface Message {
  type: 'user' | 'assistant' | 'system';
  message?: {
    content: MessageContent;
  };
  timestamp?: string | Date;
  [key: string]: unknown;
}

/**
 * Microcompact 配置
 */
export interface MicrocompactConfig {
  enabled: boolean;
  cacheBased: {
    enabled: boolean;
    maxCachedResults: number;  // 保留最近 N 个完整结果
    minToolCalls: number;       // 最少工具调用次数才触发
  };
  timeBased: {
    enabled: boolean;
    gapThresholdMinutes: number; // 时间间隔阈值（分钟）
    maxCachedResults: number;    // 保留最近 N 个完整结果
  };
}

// ============================================================================
// 日志工具
// ============================================================================

import { microcompactLog } from './logger.js';

// ============================================================================
// 默认配置
// ============================================================================

/**
 * 默认 Microcompact 配置
 */
export const DEFAULT_MICROCOMPACT_CONFIG: MicrocompactConfig = {
  enabled: true,
  cacheBased: {
    enabled: true,
    maxCachedResults: 3,
    minToolCalls: 3
  },
  timeBased: {
    enabled: true,
    gapThresholdMinutes: 30,
    maxCachedResults: 3
  }
};

// ============================================================================
// 支持压缩的工具列表
// ============================================================================

/**
 * 支持压缩的工具列表
 * 
 * 这些工具的结果可能会被重复调用，适合压缩
 * 与其他文本（如代码、配置、错误信息）不同，工具结果通常遵循可预测的模式，
 * 这使得它们非常适合进行压缩和去重。
 */
export const COMPACTABLE_TOOLS = new Set<string>([
  'read',
  'bash',
  'grep',
  'glob',
  'web',
  'search',
  'edit',
  'write',
  'feishu_doc_read',
  'feishu_bitable_list_records'
]);

/**
 * 判断工具是否支持压缩
 */
export function isCompactableTool(toolName: string): boolean {
  return COMPACTABLE_TOOLS.has(toolName);
}

// ============================================================================
// Token 估算
// ============================================================================

/**
 * 计算 ContentBlock 的 Token 数量
 * 
 * 估算策略：
 * - 文本：中文按字符数估算（约 1.5 char/token），英文按词数估算（约 0.75 word/token）
 * - 图片：固定 2000 tokens（Claude 默认）
 * - 文档：固定 2000 tokens
 * - tool_use: 工具名称 + 输入（粗略估算）
 * - tool_result: 内容大小 + 工具名称
 * 
 * @param block - ContentBlock
 * @returns Token 数量
 */
export function calculateToolResultTokens(block: ContentBlock): number {
  if (!block) {
    return 0;
  }

  switch (block.type) {
    case 'text':
      return estimateTextTokens(block.text);

    case 'image':
    case 'document':
      return 2000; // 固定 2000 tokens

    case 'tool_use':
      // 工具名称（约 50 tokens）+ 输入（估算）
      return 50 + estimateObjectTokens(block.input);

    case 'tool_result':
      // 工具结果内容（估算）
      return estimateContentTokens(block.content);

    default:
      return 0;
  }
}

/**
 * 估算文本的 Token 数量
 */
function estimateTextTokens(text: string): number {
  if (!text) {
    return 0;
  }

  // 检测是否包含中文
  const hasChinese = /[\u4e00-\u9fa5]/.test(text);

  if (hasChinese) {
    // 中文：约 1.5 字符/token
    return Math.ceil(text.length / 1.5);
  } else {
    // 英文：约 0.75 词/token，粗略估算为 4 字符/token
    return Math.ceil(text.length / 4);
  }
}

/**
 * 估算对象的 Token 数量
 */
function estimateObjectTokens(obj: Record<string, unknown> | undefined): number {
  if (!obj) {
    return 0;
  }

  let tokens = 0;

  for (const [key, value] of Object.entries(obj)) {
    // 键名（约 10 tokens）
    tokens += 10;

    // 值
    if (typeof value === 'string') {
      tokens += estimateTextTokens(value);
    } else if (typeof value === 'number') {
      tokens += 5; // 数字约 5 tokens
    } else if (typeof value === 'boolean') {
      tokens += 3; // 布尔值约 3 tokens
    } else if (value === null || value === undefined) {
      tokens += 2; // null/undefined 约 2 tokens
    } else if (typeof value === 'object') {
      // 递归估算
      const nestedTokens = estimateObjectTokens(value as Record<string, unknown>);
      tokens += nestedTokens;
    }
  }

  return tokens;
}

/**
 * 估算内容的 Token 数量
 */
function estimateContentTokens(content: ToolResultContent | undefined): number {
  if (!content) {
    return 0;
  }

  if (typeof content === 'string') {
    return estimateTextTokens(content);
  } else if (Buffer.isBuffer(content)) {
    // Buffer：按字节估算（约 4 bytes/token）
    return Math.ceil(content.length / 4);
  } else if (Array.isArray(content)) {
    // 数组：递归估算每个元素
    let tokens = 0;
    for (const item of content) {
      if (typeof item === 'string') {
        tokens += estimateTextTokens(item);
      } else {
        tokens += estimateObjectTokens(item as Record<string, unknown>);
      }
    }
    return tokens;
  } else if (typeof content === 'object') {
    return estimateObjectTokens(content as Record<string, unknown>);
  }

  return 0;
}

// ============================================================================
// Cache-based 压缩
// ============================================================================

/**
 * 应用 Cache-based 压缩
 * 
 * 策略：
 * - 统计每个工具的调用次数
 * - 保留最近 N 个完整结果（由 maxCachedResults 控制）
 * - 其余结果替换为 `[Tool Result: <name> (<bytes> bytes)]`
 * 
 * @param messages - 消息列表
 * @param maxCachedResults - 保留的完整结果数量
 * @param minToolCalls - 最少工具调用次数才触发压缩
 * @returns 压缩后的消息列表
 */
export async function applyCacheBasedCompact(
  messages: Message[],
  maxCachedResults: number = 3,
  minToolCalls: number = 3
): Promise<Message[]> {
  const log = microcompactLog;

  // 1. 统计每个工具的调用次数
  const toolCallCounts = new Map<string, number>();
  const toolCallMap = new Map<string, Message[]>(); // tool_use_id -> messages

  for (const message of messages) {
    const blocks = getBlocks(message);

    for (const block of blocks) {
      if (block.type === 'tool_use') {
        const toolName = block.name;
        const currentCount = toolCallCounts.get(toolName) || 0;
        toolCallCounts.set(toolName, currentCount + 1);

        // 记录 tool_use_id 对应的消息
        if (block.id) {
          if (!toolCallMap.has(block.id)) {
            toolCallMap.set(block.id, []);
          }
          toolCallMap.get(block.id)!.push(message);
        }
      }
    }
  }

  // 2. 找出需要压缩的工具
  const toolsToCompact = Array.from(toolCallCounts.entries())
    .filter(([_, count]) => count >= minToolCalls)
    .map(([name, _]) => name);

  if (toolsToCompact.length === 0) {
    log.debug('No tools meet the minimum call count threshold for Cache-based compaction');
    return messages;
  }

  log.debug(`Cache-based compaction triggered for ${toolsToCompact.length} tools`);

  // 3. 压缩工具结果
  const compressedMessages: Message[] = [];
  const toolResultTracker = new Map<string, number>(); // tool_name -> count

  for (const message of messages) {
    const blocks = getBlocks(message);
    let modified = false;

    const newBlocks: ContentBlock[] = [];

    for (const block of blocks) {
      if (block.type === 'tool_result') {
        // 找到对应的 tool_use
        const toolUse = findToolUseForToolResult(blocks, block.tool_use_id);

        if (toolUse && isCompactableTool(toolUse.name)) {
          const toolName = toolUse.name;
          const currentCount = toolResultTracker.get(toolName) || 0;
          toolResultTracker.set(toolName, currentCount + 1);

          // 检查是否需要压缩
          if (currentCount >= maxCachedResults) {
            const content = block.content;
            const contentSize = getContentSize(content);
            const compacted = `[Tool Result: ${toolName} (${contentSize} bytes)]`;

            newBlocks.push({
              type: 'text',
              text: compacted
            });

            modified = true;
            continue;
          }
        }
      }

      newBlocks.push(block);
    }

    if (modified) {
      compressedMessages.push({
        ...message,
        message: {
          content: newBlocks
        }
      });
    } else {
      compressedMessages.push(message);
    }
  }

  return compressedMessages;
}

/**
 * 获取消息的 ContentBlock 列表
 */
function getBlocks(message: Message): ContentBlock[] {
  if (!message?.message?.content) {
    return [];
  }

  const content = message.message.content;

  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  } else if (Array.isArray(content)) {
    return content;
  }

  return [];
}

/**
 * 找到 tool_result 对应的 tool_use
 */
function findToolUseForToolResult(blocks: ContentBlock[], toolUseId: string): ContentBlock | undefined {
  // 在消息中查找对应的 tool_use
  // 注意：这里假设 tool_use 在 tool_result 之前
  for (const block of blocks) {
    if (block.type === 'tool_use' && block.id === toolUseId) {
      return block;
    }
  }
  return undefined;
}

/**
 * 获取内容的大小（字节数）
 */
function getContentSize(content: ToolResultContent | undefined): number {
  if (!content) {
    return 0;
  }

  if (typeof content === 'string') {
    return content.length;
  } else if (Buffer.isBuffer(content)) {
    return content.length;
  } else if (Array.isArray(content)) {
    return JSON.stringify(content).length;
  } else if (typeof content === 'object') {
    return JSON.stringify(content).length;
  }

  return 0;
}

// ============================================================================
// Time-based 压缩
// ============================================================================

/**
 * 评估 Time-based 压缩触发条件
 * 
 * 检查相邻的工具调用时间间隔是否超过阈值
 * 
 * @param messages - 消息列表
 * @param gapThresholdMinutes - 时间间隔阈值（分钟）
 * @returns 需要压缩的工具列表
 */
export async function evaluateTimeBasedTrigger(
  messages: Message[],
  gapThresholdMinutes: number = 30
): Promise<string[]> {
  const toolsToCompact: string[] = [];

  // 收集所有工具调用及其时间戳
  const toolCalls: Array<{ name: string; timestamp: Date }> = [];

  for (const message of messages) {
    const blocks = getBlocks(message);
    const timestamp = parseTimestamp(message.timestamp);

    for (const block of blocks) {
      if (block.type === 'tool_use') {
        toolCalls.push({
          name: block.name,
          timestamp
        });
      }
    }
  }

  // 按时间排序
  toolCalls.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // 检查相邻调用的时间间隔
  const gapThresholdMs = gapThresholdMinutes * 60 * 1000;
  const toolCallGroups = new Map<string, Date[]>(); // tool_name -> timestamps

  for (const call of toolCalls) {
    if (!toolCallGroups.has(call.name)) {
      toolCallGroups.set(call.name, []);
    }
    toolCallGroups.get(call.name)!.push(call.timestamp);
  }

  for (const [toolName, timestamps] of toolCallGroups.entries()) {
    if (timestamps.length < 2) {
      continue; // 需要至少 2 次调用
    }

    // 检查是否有相邻调用的间隔超过阈值
    for (let i = 1; i < timestamps.length; i++) {
      const gap = timestamps[i].getTime() - timestamps[i - 1].getTime();

      if (gap >= gapThresholdMs) {
        toolsToCompact.push(toolName);
        break;
      }
    }
  }

  return toolsToCompact;
}

/**
 * 解析时间戳
 */
function parseTimestamp(timestamp: string | Date | undefined): Date {
  if (!timestamp) {
    return new Date();
  }

  if (typeof timestamp === 'string') {
    return new Date(timestamp);
  }

  return timestamp;
}

/**
 * 应用 Time-based 压缩
 * 
 * 策略：
 * - 检查相邻工具调用的时间间隔
 * - 如果间隔超过阈值，保留最近 N 个完整结果
 * - 其余结果替换为压缩格式
 * 
 * @param messages - 消息列表
 * @param gapThresholdMinutes - 时间间隔阈值（分钟）
 * @param maxCachedResults - 保留的完整结果数量
 * @returns 压缩后的消息列表
 */
export async function applyTimeBasedCompact(
  messages: Message[],
  gapThresholdMinutes: number = 30,
  maxCachedResults: number = 3
): Promise<Message[]> {
  const log = microcompactLog;

  // 1. 评估触发条件
  const toolsToCompact = await evaluateTimeBasedTrigger(messages, gapThresholdMinutes);

  if (toolsToCompact.length === 0) {
    log.debug('No tools meet the time gap threshold for Time-based compaction');
    return messages;
  }

  log.debug(`Time-based compaction triggered for ${toolsToCompact.length} tools`);

  // 2. 压缩工具结果（与 Cache-based 逻辑类似）
  // 这里简化处理，实际可以复用 Cache-based 的压缩逻辑
  return applyCacheBasedCompact(messages, maxCachedResults, 2);
}

// ============================================================================
// 主压缩函数
// ============================================================================

/**
 * 应用 Microcompact 压缩
 * 
 * 这是主要的入口函数，支持两种压缩模式：
 * 1. Cache-based：基于工具调用次数
 * 2. Time-based：基于时间间隔
 * 
 * @param messages - 消息列表
 * @param config - Microcompact 配置
 * @returns 压缩后的消息列表
 * 
 * @example
 * const compactedMessages = await applyMicrocompact(
 *   originalMessages,
 *   {
 *     enabled: true,
 *     cacheBased: { enabled: true, maxCachedResults: 3 },
 *     timeBased: { enabled: true, gapThresholdMinutes: 30 }
 *   }
 * );
 */
export async function applyMicrocompact(
  messages: Message[],
  config: MicrocompactConfig = DEFAULT_MICROCOMPACT_CONFIG
): Promise<Message[]> {
  const log = microcompactLog;

  if (!config.enabled) {
    log.debug('Microcompact is disabled');
    return messages;
  }

  let compactedMessages = [...messages];

  // 1. 应用 Cache-based 压缩
  if (config.cacheBased.enabled) {
    log.debug('Applying Cache-based compression...');
    compactedMessages = await applyCacheBasedCompact(
      compactedMessages,
      config.cacheBased.maxCachedResults,
      config.cacheBased.minToolCalls
    );
  }

  // 2. 应用 Time-based 压缩
  if (config.timeBased.enabled) {
    log.debug('Applying Time-based compression...');
    compactedMessages = await applyTimeBasedCompact(
      compactedMessages,
      config.timeBased.gapThresholdMinutes,
      config.timeBased.maxCachedResults
    );
  }

  return compactedMessages;
}

// ============================================================================
// 导出
// ============================================================================

export default {
  applyMicrocompact,
  applyCacheBasedCompact,
  applyTimeBasedCompact,
  calculateToolResultTokens,
  isCompactableTool,
  COMPACTABLE_TOOLS,
  DEFAULT_MICROCOMPACT_CONFIG
};
