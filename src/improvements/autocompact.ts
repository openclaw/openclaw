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
 */

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 消息接口（简化版）
 */
export interface Message {
  type: 'user' | 'assistant' | 'system';
  message?: {
    content: any;
  };
  timestamp?: string | Date;
  [key: string]: any;
}

/**
 * Autocompact 配置
 */
export interface AutocompactConfig {
  enabled: boolean;
  thresholdPercent: number;  // 占上下文窗口的百分比
  keepRecentTurns: number;  // 保留最近 N 轮次
  maxConsecutiveFailures: number;  // 最大连续失败次数（断路器）
  summaryModel?: string;  // 摘要使用的模型
}

// ============================================================================
// 配置定义
// ============================================================================

/**
 * 默认 Autocompact 配置
 */
export const DEFAULT_AUTOCOMPACT_CONFIG: AutocompactConfig = {
  enabled: true,
  thresholdPercent: 85,  // 上下文窗口的 85%
  keepRecentTurns: 3,     // 保留最近 3 轮次
  maxConsecutiveFailures: 3  // 连续失败 3 次后停止
};

// ============================================================================
// 模型上下文窗口大小
// ============================================================================

/**
 * 获取有效的上下文窗口大小
 * 
 * @param model - 模型名称
 * @returns 上下文窗口大小（tokens）
 */
function getEffectiveContextWindowSize(model: string): number {
  // 常见模型的上下文窗口大小
  const modelContextWindows: Record<string, number> = {
    'claude-3-5-sonnet': 200000,
    'claude-3-5-sonnet-20240229': 200000,
    'claude-3-opus': 200000,
    'claude-3-opus-20240229': 200000,
    'gpt-4': 128000,
    'gpt-4-turbo': 128000,
    'gpt-3.5-turbo': 128000,
    'gpt-35-turbo': 128000,
  };
  
  // 尝试匹配模型名称
  for (const [key, value] of Object.entries(modelContextWindows)) {
    if (model.toLowerCase().includes(key.toLowerCase())) {
      return value;
    }
  }
  
  // 默认值（保守）
  return 128000;
}

/**
 * 获取 Autocompact 阈值
 * 
 * @param model - 模型名称
 * @param config - Autocompact 配置
 * @returns Token 数量阈值
 */
export function getAutoCompactThreshold(
  model: string,
  config: AutocompactConfig = DEFAULT_AUTOCOMPACT_CONFIG
): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model);
  const autocompactThreshold = Math.floor(
    effectiveContextWindow * config.thresholdPercent / 100
  );
  
  return autocompactThreshold;
}

// ============================================================================
// 连续失败保护（断路器）
// ============================================================================

let consecutiveFailures = 0;

/**
 * 重置连续失败计数器
 */
export function resetAutocompactFailures(): void {
  consecutiveFailures = 0;
  console.log('[Autocompact] Failure counter reset');
}

/**
 * 判断是否应该执行 Autocompact
 * 
 * @param config - Autocompact 配置
 * @returns 是否应该执行
 */
export async function shouldAutocompact(
  config: AutocompactConfig = DEFAULT_AUTOCOMPACT_CONFIG
): Promise<boolean> {
  if (!config.enabled) {
    return false;
  }
  
  // 检查连续失败次数
  if (consecutiveFailures >= config.maxConsecutiveFailures) {
    console.warn(
      `[Autocompact] Skipping: too many consecutive failures (${consecutiveFailures})`
    );
    return false;
  }
  
  return true;
}

/**
 * 记录 Autocompact 失败
 */
export function recordAutocompactFailure(): void {
  consecutiveFailures++;
  console.error(`[Autocompact] Failure recorded (${consecutiveFailures}/${DEFAULT_AUTOCOMPACT_CONFIG.maxConsecutiveFailures})`);
}

// ============================================================================
// Token 估算（简化版）
// ============================================================================

/**
 * 估算消息的 Token 数量
 * 
 * @param message - 消息对象
 * @returns 估算的 Token 数量
 */
function estimateMessageTokens(message: Message): number {
  let tokens = 0;
  
  // 消息类型（约 5 tokens）
  tokens += 5;
  
  // 消息内容
  if (message.message && message.message.content) {
    const content = message.message.content;
    
    if (typeof content === 'string') {
      // 字符串：粗略估算（字符数 / 4）
      tokens += Math.ceil(content.length / 4);
    } else if (Array.isArray(content)) {
      // 数组：遍历内容块
      for (const block of content) {
        if (block && block.type) {
          tokens += 2; // 类型字段（约 2 tokens）
          
          if (block.type === 'text' && block.text) {
            tokens += Math.ceil(block.text.length / 4);
          } else if (block.type === 'tool_use' && block.name) {
            tokens += Math.ceil(block.name.length / 4);
          } else if (block.type === 'tool_result') {
            tokens += 1000; // 工具结果粗略估计
          }
        }
      }
    }
  }
  
  return tokens;
}

/**
 * 估算消息列表的总 Token 数量
 * 
 * @param messages - 消息列表
 * @returns 估算的总 Token 数量
 */
export function estimateTotalTokens(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

// ============================================================================
// 摘要生成
// ============================================================================

/**
 * 生成上下文摘要
 * 
 * @param messages - 消息列表
 * @param model - 使用的模型
 * @param config - Autocompact 配置
 * @returns 摘要文本
 */
export async function generateSummary(
  messages: Message[],
  model: string,
  config: AutocompactConfig = DEFAULT_AUTOCOMPACT_CONFIG
): Promise<string> {
  console.log('[Autocompact] Generating summary...');
  
  const keepTurns = config.keepRecentTurns;
  const recentMessages = messages.slice(-keepTurns * 2);
  const oldMessages = messages.slice(0, -keepTurns * 2);
  
  if (oldMessages.length === 0) {
    console.log('[Autocompact] No old messages to summarize');
    return '';
  }
  
  // 构建摘要提示词
  const prompt = `You are a helpful assistant that summarizes conversation history.

Recent context (keep as-is):
${formatMessagesForSummary(recentMessages)}

Old context to summarize (produce concise summary):
${formatMessagesForSummary(oldMessages)}

Produce a concise summary of the old context, focusing on:
1. Key decisions made
2. Important file paths and changes
3. Any warnings or errors
4. Configuration changes
5. User preferences mentioned

Summary format (plain text, no markdown headers):
[Summary here]
`;
  
  try {
    // 这里应该调用实际的模型 API
    // 由于这是示例代码，我们使用模拟
    const summary = await mockModelCall(model, prompt);
    
    // 成功，重置失败计数
    resetAutocompactFailures();
    
    console.log(`[Autocompact] Summary generated (${summary.length} chars)`);
    return summary;
  } catch (error) {
    console.error('[Autocompact] Summary generation failed:', error);
    recordAutocompactFailure();
    throw error;
  }
}

/**
 * 格式化消息用于摘要
 */
function formatMessagesForSummary(messages: Message[]): string {
  return messages.map((msg, index) => {
    const role = msg.type === 'assistant' ? 'Assistant' : msg.type;
    const content = msg.message?.content || '';
    
    // 简化内容
    let contentStr = '';
    if (typeof content === 'string') {
      contentStr = content.slice(0, 200); // 限制长度
    } else if (Array.isArray(content)) {
      contentStr = JSON.stringify(content).slice(0, 300);
    }
    
    return `${index + 1}. [${role}]: ${contentStr}`;
  }).join('\n\n');
}

/**
 * 模拟模型调用（示例用）
 */
async function mockModelCall(model: string, prompt: string): Promise<string> {
  // 模拟 API 调用延迟
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // 返回模拟摘要
  return `Summary: Conversation contains ${prompt.length} characters. Key topics: file operations, system configuration, and user preferences.`;
}

// ============================================================================
// 高级接口
// ============================================================================

/**
 * 应用 Autocompact 压缩
 * 
 * 这是主要入口函数：
 * 1. 检查 Token 数量是否超过阈值
 * 2. 如果超过，生成摘要
 * 3. 保留最近 N 轮次
 * 
 * @param messages - 消息列表
 * @param model - 使用的模型
 * @param config - Autocompact 配置
 * @returns 压缩后的消息列表
 */
export async function applyAutocompact(
  messages: Message[],
  model: string,
  config: AutocompactConfig = DEFAULT_AUTOCOMPACT_CONFIG
): Promise<Message[]> {
  if (!config.enabled) {
    return messages;
  }
  
  console.log(`[Autocompact] Checking ${messages.length} messages...`);
  
  // 1. 估算 Token 数量
  const totalTokens = estimateTotalTokens(messages);
  const threshold = getAutoCompactThreshold(model, config);
  
  console.log(`[Autocompact] Total tokens: ${totalTokens}, Threshold: ${threshold}`);
  
  // 2. 检查是否超过阈值
  if (totalTokens < threshold) {
    console.log('[Autocompact] Below threshold, no compression needed');
    return messages;
  }
  
  // 3. 检查是否应该执行 Autocompact
  const shouldCompact = await shouldAutocompact(config);
  if (!shouldCompact) {
    console.log('[Autocompact] Skipping due to failures');
    return messages;
  }
  
  // 4. 生成摘要
  try {
    const summary = await generateSummary(messages, model, config);
    
    // 5. 构建压缩后的消息列表
    const recentMessages = messages.slice(-config.keepRecentTurns * 2);
    const compactedMessages: Message[] = [
      {
        type: 'system',
        message: {
          content: `[Autocompact] Previous context summarized:\n\n${summary}\n\n---\n\n`
        },
        timestamp: new Date()
      },
      ...recentMessages
    ];
    
    console.log(`[Autocompact] Compressed ${messages.length} → ${compactedMessages.length} messages`);
    
    return compactedMessages;
  } catch (error) {
    console.error('[Autocompact] Compression failed, returning original messages');
    return messages;
  }
}

// ============================================================================
// 导出
// ============================================================================

export default {
  DEFAULT_AUTOCOMPACT_CONFIG,
  getAutoCompactThreshold,
  shouldAutocompact,
  resetAutocompactFailures,
  recordAutocompactFailure,
  generateSummary,
  applyAutocompact
};
