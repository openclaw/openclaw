/**
 * OpenClaw 改进功能集成示例
 * 
 * 本文件展示如何将工具并发执行、Microcompact 和 Autocompact
 * 集成到 OpenClaw 的现有流程中。
 * 
 * 创建时间: 2026-04-05
 */

// ============================================================================
// 导入改进功能
// ============================================================================

import {
  executeToolsWithConcurrency,
  ToolCall,
  ToolResult
} from './tool-concurrent.js';

import {
  applyMicrocompact,
  MicrocompactConfig,
  DEFAULT_MICROCOMPACT_CONFIG
} from './microcompact.js';

import {
  applyAutocompact,
  AutocompactConfig,
  DEFAULT_AUTOCOMPACT_CONFIG
} from './autocompact.js';

// ============================================================================
// 类型定义
// ============================================================================

/**
 *   简化的消息类型（与 OpenClaw 的 AgentMessage 兼容）
 */
export interface OpenClawMessage {
  type: 'user' | 'assistant' | 'system';
  role: 'user' | 'assistant' | 'system';
  content: any;
  timestamp?: Date | string;
  [key: string]: any;
}

// ============================================================================
// 工具执行集成
// ============================================================================

/**
 * OpenClaw 的原始工具执行器（示例）
 */
async function originalOpenClawToolExecutor(call: ToolCall): Promise<ToolResult> {
  // 这里是 OpenClaw 原有的工具执行逻辑
  console.log(`[OpenClaw] Executing tool: ${call.name}`);
  
  // 模拟工具执行
  await new Promise(resolve => setTimeout(resolve, 50));
  
  return {
    success: true,
    data: { result: `Result for ${call.name}` }
  };
}

/**
 * 改进后的工具执行器 - 使用并发执行
 * 
 * 这是集成点：替换 OpenClaw 的工具执行循环
 */
export async function improvedToolExecutor(
  toolCalls: ToolCall[]
): Promise<ToolResult[]> {
  console.log(`[Improved Tool Executor] Executing ${toolCalls.length} tool calls...`);
  
  const startTime = Date.now();
  
  // 使用我们的并发执行器
  const results = await executeToolsWithConcurrency(
    toolCalls,
    originalOpenClawToolExecutor,
    {
      maxConcurrency: 10,  // 默认并发数
      logEnabled: true     // 启用日志
    }
  );
  
  const elapsed = Date.now() - startTime;
  console.log(`[Improved Tool Executor] Completed ${toolCalls.length} tools in ${elapsed}ms`);
  
  return results;
}

/**
 * 使用示例：在 OpenClaw 的工具执行流程中替换
 * 
 * 原代码（可能在 src/agents/xxx-runner.ts 中）：
 * 
 * ```typescript
 * async function executeToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
 *   const results: ToolResult[] = [];
 *   for (const call of toolCalls) {
 *     results.push(await originalOpenClawToolExecutor(call));
 *   }
 *   return results;
 * }
 * ```
 * 
 * 改进后：
 * 
 * ```typescript
 * import { improvedToolExecutor } from './improvements/integration-example.js';
 * 
 * async function executeToolCalls(toolCalls: ToolCall[]): Promise<ToolResult[]> {
 *   return await improvedToolExecutor(toolCalls);
 * }
 * ```
 */

// ============================================================================
// 压缩集成
// ============================================================================

/**
 * 改进后的消息压缩函数
 * 
 * 整合 Microcompact 和 Autocompact
 */
export async function improvedMessageCompactor(
  messages: OpenClawMessage[],
  contextWindow: number = 128000,
  model: string = 'claude-3-5-sonnet',
  options?: {
    microcompact?: Partial<MicrocompactConfig>;
    autocompact?: Partial<AutocompactConfig>;
  }
): Promise<{
  compactedMessages: OpenClawMessage[];
  microcompactApplied: boolean;
  autocompactApplied: boolean;
  originalTokens: number;
  compactedTokens: number;
}> {
  console.log(`[Improved Compactor] Compacting ${messages.length} messages...`);
  
  const originalTokens = estimateSimpleTokens(messages);
  console.log(`[Improved Compactor] Original tokens: ${originalTokens}`);
  
  let compactedMessages = [...messages];
  let microcompactApplied = false;
  let autocompactApplied = false;
  
  // 第一步：应用 Microcompact
  if (options?.microcompact !== undefined) {
    const microcompactConfig: MicrocompactConfig = {
      ...DEFAULT_MICROCOMPACT_CONFIG,
      ...options.microcompact
    };
    
    console.log('[Improved Compactor] Applying Microcompact...');
    compactedMessages = await applyMicrocompact(
      compactedMessages,
      microcompactConfig
    );
    microcompactApplied = true;
  }
  
  // 第二步：应用 Autocompact
  if (options?.autocompact !== undefined) {
    const autocompactConfig: AutocompactConfig = {
      ...DEFAULT_AUTOCOMPACT_CONFIG,
      ...options.autocompact
    };
    
    console.log('[Improved Compactor] Applying Autocompact...');
    compactedMessages = await applyAutocompact(
      compactedMessages,
      model,
      autocompactConfig
    );
    autocompactApplied = true;
  }
  
  const compactedTokens = estimateSimpleTokens(compactedMessages);
  const savedTokens = originalTokens - compactedTokens;
  const savedPercent = ((savedTokens / originalTokens) * 100).toFixed(1);
  
  console.log(
    `[Improved Compactor] Compacted ${messages.length} → ${compactedMessages.length} messages`
  );
  console.log(
    `[Improved Compactor] Tokens: ${originalTokens} → ${compactedTokens} (saved ${savedPercent}%)`
  );
  
  return {
    compactedMessages,
    microcompactApplied,
    autocompactApplied,
    originalTokens,
    compactedTokens
  };
}

/**
 * 简化的 Token 估算函数
 */
function estimateSimpleTokens(messages: OpenClawMessage[]): number {
  let tokens = 0;
  
  for (const msg of messages) {
    // 消息类型（约 5 tokens）
    tokens += 5;
    
    // 内容
    if (msg.content) {
      if (typeof msg.content === 'string') {
        tokens += Math.ceil(msg.content.length / 4);
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (typeof block === 'string') {
            tokens += Math.ceil(block.length / 4);
          } else if (block && typeof block === 'object') {
            tokens += 50; // 粗略估计
          }
        }
      }
    }
  }
  
  return tokens;
}

/**
 * 使用示例：在 OpenClaw 的压缩流程中替换
 * 
 * 原代码（可能在 src/agents/compaction.ts 中）：
 * 
 * ```typescript
 * export function pruneHistoryForContextShare(params: {
 *   messages: AgentMessage[];
 *   maxContextTokens: number;
 * }): { messages: AgentMessage[]; droppedTokens: number; } {
 *   // 原有的压缩逻辑
 *   // ...
 * }
 * ```
 * 
 * 改进后（可以作为增强）：
 * 
 * ```typescript
 * import { improvedMessageCompactor } from './improvements/integration-example.js';
 * 
 * export function pruneHistoryForContextShare(params: {
 *   messages: AgentMessage[];
 *   maxContextTokens: number;
 * }): { messages: AgentMessage[]; droppedTokens: number; } {
 *   // 先尝试我们的改进压缩
 *   const improved = await improvedMessageCompactor(
 *     params.messages,
 *     params.maxContextTokens,
 *     'claude-3-5-sonnet',
 *     {
 *       microcompact: { enabled: true },
 *       autocompact: { enabled: true }
 *     }
 *   );
 *   
 *   // 如果仍然超过限制，使用原有的压缩逻辑
 *   if (improved.compactedTokens > params.maxContextTokens) {
 *     return originalPruneHistoryForContextShare({
 *       messages: improved.compactedMessages,
 *       maxContextTokens: params.maxContextTokens
 *     });
 *   }
 *   
 *   return {
 *     messages: improved.compactedMessages,
 *     droppedTokens: improved.originalTokens - improved.compactedTokens
 *   };
 * }
 * ```
 */

// ============================================================================
// 完整集成示例
// ============================================================================

/**
 * 完整的 OpenClaw 运行时集成示例
 * 
 * 展示如何在 OpenClaw 的主循环中使用改进功能
 */
export async function: OpenClawRuntimeWithImprovements {
  // 模拟输入
  const toolCalls: ToolCall[] = [
    { name: 'read', path: '/file1.txt' },
    { name: 'read', path: '/file2.txt' },
    { name: 'read', path: '/file3.txt' },
    { name: 'web_search', query: 'test' },
    { name: 'write', path: '/output.txt', content: '...' }
  ];
  
  const messages: OpenClawMessage[] = [
    // 模拟历史消息
  ];
  
  console.log('=== OpenClaw Runtime with Improvements ===\n');
  
  // 1. 压缩消息（如果启用）
  const compacted = await improvedMessageCompactor(
    messages,
    128000,
    'claude-3-5-sonnet',
    {
      microcompact: {
        enabled: true,
        cacheBased: { enabled: true },
        timeBased: { enabled: true }
      },
      autocompact: {
        enabled: true,
        thresholdPercent: 85
      }
    }
  );
  
  // 2. 执行工具（使用并发）
  const toolResults = await improvedToolExecutor(toolCalls);
  
  // 3. 返回结果
  return {
    compactedMessages: compacted.compactedMessages,
    toolResults,
    stats: {
      messagesCompacted: compacted.microcompactApplied || compacted.autocompactApplied,
      toolConcurrencyUsed: true,
      originalTokens: compacted.originalTokens,
      compactedTokens: compacted.compactedTokens,
      savedTokens: compacted.originalTokens - compacted.compactedTokens
    }
  };
}

// ============================================================================
// 导出
// ============================================================================

export default {
  improvedToolExecutor,
  improvedMessageCompactor,
  OpenClawRuntimeWithImprovements
};
