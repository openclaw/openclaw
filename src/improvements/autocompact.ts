/**
 * OpenClaw 上下文自动摘要
 * 
 * 基于对 Claude Code 源码的分析，实现了 Autocompact 机制：
 * - Token 数量超过阈值时自动触发
 * - 使用大模型生成摘要
 * - 保留最近 N 轮次
 * - 连续失败保护（断路器）
 * 
 * 目的：在 Token 耗尽前自动压缩上下文，延长会话寿命
 * 
 * 创建时间: 2026-04-05
 * 优化时间: 2026-04-05 (日志优化、类型改进)
 */

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 消息内容块类型
 */
export type ContentBlock = 
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; id: string; input?: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content?: unknown }
  | { type: 'image'; source?: Record<string, unknown> }
  | { type: 'document'; source?: Record<string, unknown> };

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
 * Autocompact 配置
 */
export interface AutocompactConfig {
  enabled: boolean;
  thresholdPercent: number;       // 触发阈值（上下文窗口的百分比）
  keepRecentTurns: number;        // 保留最近 N 轮次
  maxConsecutiveFailures: number; // 连续失败保护阈值
  summaryModel: string;            // 用于生成摘要的模型
  summaryPrompt?: string;          // 自定义摘要提示词
}

/**
 * 摘要生成器类型
 */
export type SummaryGenerator = (messages: Message[]) => Promise<string>;

// ============================================================================
// 日志工具
// ============================================================================

import { autocompactLog } from './logger.js';

// ============================================================================
// 默认配置
// ============================================================================

/**
 * 默认 Autocompact 配置
 */
export const DEFAULT_AUTOCOMPACT_CONFIG: AutocompactConfig = {
  enabled: true,
  thresholdPercent: 85,           // 上下文窗口的 85%
  keepRecentTurns: 3,            // 保留最近 3 轮次
  maxConsecutiveFailures: 3,      // 最多连续失败 3 次
  summaryModel: 'claude-3-5-sonnet-20241022',
  summaryPrompt: undefined
};

// ============================================================================
// 断路器状态
// ============================================================================

/**
 * 断路器状态
 * 用于防止连续失败导致无限循环
 */
let consecutiveFailures = 0;
let isCircuitOpen = false;

/**
 * 重置 Autocompact 失败计数
 */
export function resetAutocompactFailures(): void {
  consecutiveFailures = 0;
  isCircuitOpen = false;
}

/**
 * 记录 Autocompact 失败
 */
export function recordAutocompactFailure(): void {
  consecutiveFailures++;
}

/**
 * 获取失败计数
 */
export function getAutocompactFailures(): number {
  return consecutiveFailures;
}

/**
 * 检查断路器是否打开
 */
export function isAutocompactCircuitOpen(): boolean {
  return isCircuitOpen;
}

// ============================================================================
// Token 估算
// ============================================================================

/**
 * 粗略估算消息的 Token 数量
 * 
 * 这是一个简化的估算，用于判断是否需要压缩
 * 实际的 Token 计算应该使用 OpenAI 或 Anthropic 的 tokenizer
 * 
 * @param messages - 消息列表
 * @returns Token 数量
 */
export function estimateTotalTokens(messages: Message[]): number {
  let total = 0;

  for (const message of messages) {
    const blocks = getBlocks(message);

    for (const block of blocks) {
      switch (block.type) {
        case 'text':
          // 文本：约 4 字符/token
          total += Math.ceil(block.text.length / 4);
          break;

        case 'tool_use':
          // 工具名称 + 输入：约 100 tokens
          total += 100;
          break;

        case 'tool_result':
          // 工具结果：约 200 tokens（简化）
          total += 200;
          break;

        case 'image':
        case 'document':
          // 图片/文档：固定 2000 tokens
          total += 2000;
          break;
      }
    }
  }

  return total;
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

// ============================================================================
// 触发条件评估
// ============================================================================

/**
 * 计算 Autocompact 的触发阈值
 * 
 * @param contextWindow - 上下文窗口大小
 * @param thresholdPercent - 阈值百分比
 * @returns Token 数量阈值
 */
export function getAutoCompactThreshold(
  contextWindow: number = 128000,
  thresholdPercent: number = DEFAULT_AUTOCOMPACT_CONFIG.thresholdPercent
): number {
  return Math.floor(contextWindow * (thresholdPercent / 100));
}

/**
 * 评估是否应该触发 Autocompact
 * 
 * 条件：
 * 1. Autocompact 已启用
 * 2. 断路器未打开
 * 3. Token 数量超过阈值
 * 
 * @param messages - 消息列表
 * @param contextWindow - 上下文窗口大小
 * @param config - Autocompact 配置
 * @returns 是否应该应该触发
 */
export async function shouldAutocompact(
  messages: Message[],
  contextWindow: number = 128000,
  config: AutocompactConfig = DEFAULT_AUTOCOMPACT_CONFIG
): Promise<boolean> {
  const log = autocompactLog;

  // 1. 检查是否启用
  if (!config.enabled) {
    log.debug('Autocompact is disabled');
    return false;
  }

  // 2. 检查断路器
  if (isAutocompactCircuitOpen()) {
    log.debug('Autocompact circuit is open, skipping');
    return false;
  }

  // 3. 估算 Token 数量
  const estimatedTokens = estimateTotalTokens(messages);
  const threshold = getAutoCompactThreshold(contextWindow, config.thresholdPercent);

  log.debug(`Estimated tokens: ${estimatedTokens}, threshold: ${threshold}`);

  if (estimatedTokens < threshold) {
    log.debug('Token count below threshold, no compression needed');
    return false;
  }

  log.info(`Token count (${estimatedTokens}) above threshold (${threshold}), triggering Autocompact`);

  return true;
}

// ============================================================================
// 摘要生成
// ============================================================================

/**
 * 生成摘要
 * 
 * 这是一个简化版本，实际应该调用大模型 API
 * 
 * @param messages - 消息列表
 * @param model - 模型名称
 * @param prompt - 自定义提示词
 * @returns 摘要文本
 */
export async function generateSummary(
  messages: Message[],
  model: string = DEFAULT_AUTOCOMPACT_CONFIG.summaryModel,
  prompt?: string
): Promise<string> {
  const log = autocompactLog;

  // TODO: 实际实现应该调用大模型 API
  // 这里返回一个占位符摘要
  log.info(`Generating summary using model: ${model}`);

  // 模拟摘要生成
  const summaryText = prompt || 'Summary of conversation:';

  return `${summaryText}\n\n[This is a placeholder for actual summary generated by ${model}]\n\nTo implement this, integrate with your model API client.`;
}

/**
 * 应用自定义摘要生成器
 * 
 * 允许用户提供自己的摘要生成逻辑
 * 
 * @param customGenerator - 自定义摘要生成器
 */
export function setCustomSummaryGenerator(customGenerator: SummaryGenerator): void {
  // TODO: 实现自定义摘要生成器的注册和使用
  // 这需要在 applyAutocompact 中检查是否有自定义生成器
}

// ============================================================================
// 主压缩函数
// ============================================================================

/**
 * 应用 Autocompact 压缩
 * 
 * 这是主要的入口函数，实现了完整的 Autocompact 流程：
 * 1. 评估是否应该触发
 * 2. 生成摘要
 * 3. 保留最近 N 轮次
 * 4. 断路器保护
 * 
 * @param messages - 消息列表
 * @param model - 模型名称
 * @param contextWindow - 上下文窗口大小
 * @param config - Autocompact 配置
 * @returns 压缩后的消息列表
 * 
 * @example
 * const compactedMessages = await applyAutocompact(
 *   originalMessages,
 *   'claude-3-5-sonnet-20241022',
 *   128000,
 *   {
 *     enabled: true,
 *     thresholdPercent: 85,
 *     keepRecentTurns: 3
 *   }
 * );
 */
export async function applyAutocompact(
  messages: Message[],
  model: string = DEFAULT_AUTOCOMPACT_CONFIG.summaryModel,
  contextWindow: number = 128000,
  config: AutocompactConfig = DEFAULT_AUTOCOMPACT_CONFIG
): Promise<Message[]> {
  const log = autocompactLog;

  // 1. 评估触发条件
  const shouldTrigger = await shouldAutocompact(messages, contextWindow, config);

  if (!shouldTrigger) {
    return messages;
  }

  try {
    // 2. 分离旧消息和最近消息
    const { oldMessages, recentMessages } = splitMessages(
      messages,
      config.keepRecentTurns
    );

    log.info(`Splitting ${messages.length} messages into ${oldMessages.length} old + ${recentMessages.length} recent`);

    if (oldMessages.length === 0) {
      log.info('No old messages to compress');
      return messages;
    }

    // 3. 生成摘要
    const summary = await generateSummary(oldMessages, model, config.summaryPrompt);

    log.info(`Generated summary (${summary.length} chars)`);

    // 4. 构建压缩后的消息
    const compactedMessages: Message[] = [
      {
        type: 'system',
        message: {
          content: [
            {
              type: 'text',
              text: summary
            }
 }
          ]
        }
      },
      ...recentMessages
    ];

    // 5. 重置失败计数
    consecutiveFailures = 0;
    isCircuitOpen = false;

    const originalTokens = estimateTotalTokens(messages);
    const compactedTokens = estimateTotalTokens(compactedMessages);
    const savedTokens = originalTokens - compactedTokens;
    const savedPercent = ((savedTokens / originalTokens) * 100).toFixed(1);

    log.info(
      `Autocompact complete: ${originalTokens} → ${compactedTokens} tokens (saved ${savedPercent}%)`
    );

    return compactedMessages;

  } catch (error) {
    // 6. 错误处理和断路器保护
    log.error('Autocompact failed:', error);

    recordAutocompactFailure();

    if (consecutiveFailures >= config.maxConsecutiveFailures) {
      isCircuitOpen = true;
      log.warn(
        `Autocompact circuit opened after ${consecutiveFailures} consecutive failures`
      );
    }

    // 返回原始消息
    return messages;
  }
}

/**
 * 分离旧消息和最近消息
 * 
 * 保留最近 N 轮次，其余作为旧消息
 * 
 * @param messages - 消息列表
 * @param keepRecentTurns - 保留的最近轮次
 * @returns 分离后的消息
 */
function splitMessages(
  messages: Message[],
  keepRecentTurns: number
): { oldMessages: Message[]; recentMessages: Message[] } {
  if (messages.length <= keepRecentTurns) {
    return { oldMessages: [], recentMessages: messages };
  }

  // 简化处理：保留最后的 N 条消息
  // 实际应该根据 user/assistant 对来确定"轮次"
  const splitIndex = messages.length - keepRecentTurns;

  return {
    oldMessages: messages.slice(0, splitIndex),
    recentMessages: messages.slice(splitIndex)
  };
}

// ============================================================================
// 导出
// ============================================================================

export default {
  applyAutocompact,
  shouldAutocompact,
  generateSummary,
  getAutoCompactThreshold,
  resetAutocompactFailures,
  recordAutocompactFailure,
  getAutocompactFailures,
  isAutocompactCircuitOpen,
  DEFAULT_AUTOCOMPACT_CONFIG
};
