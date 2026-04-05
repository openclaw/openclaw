/**
 * OpenClaw 工具结果自动压缩
 * 
 * 基于对 Claude Code 源码的分析，实现了 Microcompact 机制：
 * - Cache-based: 基于工具调用次数的压缩
 * - Time-based: 基于时间间隔的压缩
 * - 智能 Token 估算
 * 
 * 目的：减少上下文中的 Token 消耗，延长会话寿命
 * 
 * 创建时间: 2026-04-05
 */

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 消息块类型
 */
export type ContentBlock = 
  | { type: 'text'; text: string }
  | { type: 'tool_use'; name: string; id: string; input?: any }
  | { type: 'tool_result'; tool_use_id: string; content?: any }
  | { type: 'image'; source?: any; detail?: any }
  | { type: 'document'; source?: any; detail?: any };

/**
 * 消息接口
 */
export interface Message {
  type: 'user' | 'assistant' | 'system';
  message?: {
    content: ContentBlock[] | string;
  };
  timestamp?: string | Date;
  [key: string]: any;
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
    gapThresholdMinutes: number;  // 时间间隔阈值（分钟）
    keepRecentCount: number;        // 保留最近的个数
  };
}

// ============================================================================
// 配置定义
// ============================================================================

/**
 * 默认 Microcompact 配置
 */
export const DEFAULT_MICROCOMPACT_CONFIG: MicrocompactConfig = {
  enabled: true,
  cacheBased: {
    enabled: true,
    maxCachedResults: 3,  // 保留最近 3 个完整结果
    minToolCalls: 1      // 每次工具调用后都检查
  },
  timeBased: {
    enabled: true,
    gapThresholdMinutes: 30,  // 距离上次调用 > 30 分钟才压缩
    keepRecentCount: 3
  }
};

// ============================================================================
// 可压缩工具列表
// ============================================================================

/**
 * 可压缩的工具列表
 * 
 * 这些工具的结果可以被压缩以节省 Token
 */
export const COMPACTABLE_TOOLS = new Set<string>([
  'read',
  'exec',           // Bash 命令
  'grep',
  'glob',
  'web_search',
  'web_fetch',
  'edit',
  'write',
  'feishu_bitable_list_records',  // Bitable 记录列表
]);

// ============================================================================
// Token 估算
// ============================================================================

/**
 * 图片/文档的 Token 估算（保守估计）
 */
const IMAGE_MAX_TOKEN_SIZE = 2000;

/**
 * 粗略的 Token 估算
 * 
 * 策略：
 * - 中文：约 1.5 字符/token
 * - 英文：约 4 字符/token
 * 
 * @param text - 文本内容
 * @returns 估算的 Token 数量
 */
function roughTokenCountEstimation(text: string): number {
  if (!text || text.length === 0) {
    return 0;
  }
  
  // 中文字符范围：\u4e00-\u9fa5
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  // 其他字符
  const otherChars = text.length - chineseChars;
  
  // 计算：中文字符 / 1.5 + 其他字符 / 4
  return Math.ceil((chineseChars / 1.5) + (otherChars / 4));
}

/**
 * 计算工具结果的 Token 数量
 * 
 * @param block - 工具结果块
 * @returns 估算的 Token 数量
 */
export function calculateToolResultTokens(block: any): number {
  if (!block) return 0;
  
  // 字符串内容
  if (typeof block.content === 'string') {
    return roughTokenCountEstimation(block.content);
  }
  
  // 数组内容
  if (Array.isArray(block.content)) {
    return block.content.reduce((sum: number, item: any) => {
      if (item && item.type === 'text') {
        return sum + roughTokenCountEstimation(item.text);
      } else if (item && (item.type === 'image' || item.type === 'document')) {
        // 图片/文档：固定 2000 tokens（保守估计）
        return sum + IMAGE_MAX_TOKEN_SIZE;
      }
      return sum;
    }, 0);
  }
  
  return 0;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 提取内容数组
 */
function extractContentArray(content: any): ContentBlock[] {
  if (Array.isArray(content)) {
    return content;
  }
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  return [];
}

// ============================================================================
// Cache-based 压缩
// ============================================================================

/**
 * 应用基于缓存的压缩
 * 
 * 策略：只保留每个工具最近 N 个完整结果，旧结果替换为压缩标记
 * 
 * @param messages - 消息列表
 * @param config - Microcompact 配置
 * @returns 压缩后的消息列表
 */
export async function applyCacheBasedCompact(
  messages: Message[],
  config: MicrocompactConfig
): Promise<Message[]> {
  if (!config.enabled || !config.cacheBased.enabled) {
    return messages;
  }
  
  console.log('[Microcompact: Cache-based] Applying compression...');
  
  // 1. 统计每个工具的调用次数
  const toolCallCount = new Map<string, number>();
  
  for (const msg of messages) {
    if (msg.type === 'assistant') {
      const content = extractContentArray(msg.message?.content);
      for (const block of content) {
        if (block.type === 'tool_use') {
          toolCallCount.set(
            block.name,
            (toolCallCount.get(block.name) || 0) + 1
          );
        }
      }
    }
  }

  // 2. 遍历消息，压缩旧的工具结果
  const compactedMessages: Message[] = [];
  const toolResultCache = new Map<string, number>();

  for (const msg of messages) {
    if (msg.type === 'assistant') {
      const content = extractContentArray(msg.message?.content);
      const newContent: ContentBlock[] = [];
      
      for (const block of content) {
        if (block.type === 'tool_result') {
          const toolName = block.tool_use_id || '';
          const callCount = toolCallCount.get(toolName) || 0;
          
          // 判断是否需要压缩
          if (COMPACTABLE_TOOLS.has(toolName) && 
              callCount > config.cacheBased.minToolCalls) {
            const cached = toolResultCache.get(toolName) || 0;
            
            // 只保留最近的 N 个完整结果
            if (cached < config.cacheBased.maxCachedResults) {
              newContent.push(block);
              toolResultCache.set(toolName, cached + 1);
            } else {
              // 替换为压缩标记
              newContent.push({
                type: 'text',
                text: `... [${toolName} older result compacted to save tokens]`
              });
            }
          } else {
            newContent.push(block);
          }
        } else {
          newContent.push(block);
        }
      }
      
      compactedMessages.push({
        ...msg,
        message: {
          ...msg.message,
          content: newContent
        }
      });
    } else {
      compactedMessages.push(msg);
    }
  }

  console.log(`[Microcompact: Cache-based] Compressed messages: ${messages.length} → ${compactedMessages.length}`);
  return compactedMessages;
}

// ============================================================================
// Time-based 压缩
// ============================================================================

/**
 * 评估是否应该触发 Time-based 压缩
 * 
 * 触发条件：
 * - 距离上次 assistant 消息 > 阈值（分钟）
 * - 只在主线程查询中触发
 * 
 * @param messages - 消息列表
 * @param config - Microcompact 配置
 * @returns 是否应该触发压缩
 */
export async function evaluateTimeBasedTrigger(
  messages: Message[],
  config: MicrocompactConfig
): Promise<boolean> {
  if (!config.enabled || !config.timeBased.enabled) {
    return false;
  }
  
  // 查找最后一个 assistant 消息
  const lastAssistant = messages.findLast((m: Message) => m.type === 'assistant');
  
  if (!lastAssistant) {
    return false;
  }
  
  // 计算时间间隔（分钟）
  const lastTime = lastAssistant.timestamp instanceof Date 
    ? lastAssistant.timestamp.getTime() 
    : new Date(lastAssistant.timestamp || '').getTime();
  const gapMinutes = (Date.now() - lastTime) / 60000;
  
  // 只有超过阈值才触发
  return Number.isFinite(gapMinutes) && 
         gapMinutes >= config.timeBased.gapThresholdMinutes;
}

/**
 * 应用基于时间的压缩
 * 
 * @param messages - 消息列表
 * @param config - Microcompact 配置
 * @returns 压缩后的消息列表
 */
export async function applyTimeBasedCompact(
  messages: Message[],
  config: MicrocompactConfig
): Promise<Message[]> {
  if (!config.enabled || !config.timeBased.enabled) {
    return messages;
  }
  
  console.log('[Microcompact: Time-based] Applying compression...');
  
  // 保留最近的 N 个结果
  const keepCount = config.timeBased.keepRecentCount;
  
  // 统计工具结果数量
  const toolResultCount = new Map<string, number>();
  
  for (const msg of messages) {
    if (msg.type === 'assistant') {
      const content = extractContentArray(msg.message?.content);
      for (const block of content) {
        if (block.type === 'tool_result') {
          const toolName = block.tool_use_id || '';
          toolResultCount.set(
            toolName,
            (toolResultCount.get(toolName) || 0) + 1
          );
        }
      }
    }
  }
  
  // 压缩消息
  const compactedMessages: Message[] = [];
  const toolResultKeepCount = new Map<string, number>();

  for (const msg of messages) {
    if (msg.type === 'assistant') {
      const content = extractContentArray(msg.message?.content);
      const newContent: ContentBlock[] = [];
      
      for (const block of content) {
        if (block.type === 'tool_result') {
          const toolName = block.tool_use_id || '';
          const total = toolResultCount.get(toolName) || 0;
          const kept = toolResultKeepCount.get(toolName) || 0;
          
          // 只保留最近的 N 个
          if (kept < keepCount) {
            newContent.push(block);
            toolResultKeepCount.set(toolName, kept + 1);
          } else {
            newContent.push({
              type: 'text',
              text: `... [${toolName} older ${total - keepCount} results compacted]`
            });
          }
        } else {
          newContent.push(block);
        }
      }
      
      compactedMessages.push({
        ...msg,
        message: {
          ...msg.message,
          content: newContent
        }
      });
    } else {
      compactedMessages.push(msg);
    }
  }

  console.log(`[Microcompact: Time-based] Compressed messages: ${messages.length} → ${compactedMessages.length}`);
  return compactedMessages;
}

// ============================================================================
// 高级接口
// ============================================================================

/**
 * 应用 Microcompact 压缩
 * 
 * 这是主要入口函数，按优先级应用压缩策略
 * 
 * @param messages - 消息列表
 * @param config - Microcompact 配置
 * @returns 压缩后的消息列表
 */
export async function applyMicrocompact(
  messages: Message[],
  config: MicrocompactConfig = DEFAULT_MICROCOMPACT_CONFIG
): Promise<Message[]> {
  if (!config.enabled) {
    return messages;
  }
  
  console.log(`[Microcompact] Starting compression on ${messages.length} messages`);
  
  let result = messages;
  
  // 1. 应用 Cache-based 压缩
  if (config.cacheBased.enabled) {
    result = await applyCacheBasedCompact(result, config);
  }
  
  // 2. 应用 Time-based 压缩
  if (config.timeBased.enabled) {
    const shouldApply = await evaluateTimeBasedTrigger(result, config);
    if (shouldApply) {
      result = await applyTimeBasedCompact(result, config);
    }
  }
  
  return result;
}

// ============================================================================
// 导出
// ============================================================================

export default {
  COMPACTABLE_TOOLS,
  calculateToolResultTokens,
  applyCacheBasedCompact,
  evaluateTimeBasedTrigger,
  applyTimeBasedCompact,
  applyMicrocompact
};
