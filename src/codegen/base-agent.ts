/**
 * 智能体基类
 * 所有角色智能体都继承自这个基类
 */

import type {
  AgentRole,
  AgentMessage,
  AgentConfig,
} from './types.js';

export interface AgentContext {
  /** 请求ID */
  request_id: string;
  /** 任务ID */
  task_id: string;
  /** 上下文数据 */
  context: Record<string, any>;
  /** LLM 客户端 */
  llm: LLMClient;
}

export interface LLMClient {
  /** 调用 LLM */
  chat(messages: Array<{ role: string; content: string }>): Promise<string>;
  /** 流式调用 */
  chatStream(
    messages: Array<{ role: string; content: string }>,
    onChunk: (chunk: string) => void
  ): Promise<string>;
}

/**
 * 智能体基类
 */
export abstract class BaseAgent {
  protected config: AgentConfig;
  protected role: AgentRole;

  constructor(config: AgentConfig) {
    this.config = config;
    this.role = config.role;
  }

  /**
   * 获取角色
   */
  getRole(): AgentRole {
    return this.role;
  }

  /**
   * 获取系统提示词
   */
  protected getSystemPrompt(): string {
    return this.config.system_prompt;
  }

  /**
   * 执行任务（抽象方法，由子类实现）
   */
  abstract execute(
    input: any,
    context: AgentContext
  ): Promise<any>;

  /**
   * 构建消息历史
   */
  protected buildMessages(
    userMessage: string,
    context?: Array<{ role: string; content: string }>
  ): Array<{ role: string; content: string }> {
    const messages: Array<{ role: string; content: string }> = [
      {
        role: 'system',
        content: this.getSystemPrompt(),
      },
    ];

    // 添加上下文消息
    if (context && context.length > 0) {
      messages.push(...context);
    }

    // 添加用户消息
    messages.push({
      role: 'user',
      content: userMessage,
    });

    return messages;
  }

  /**
   * 调用 LLM
   */
  protected async callLLM(
    messages: Array<{ role: string; content: string }>,
    context: AgentContext
  ): Promise<string> {
    try {
      const response = await context.llm.chat(messages);
      return response;
    } catch (error) {
      throw new Error(
        `LLM call failed for ${this.role}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * 解析 JSON 响应
   */
  protected parseJSONResponse<T>(response: string): T {
    try {
      // 尝试提取 JSON（可能被包裹在 markdown 代码块中）
      const jsonMatch = response.match(/```json\n([\s\S]*?)\n```/);
      const jsonStr = jsonMatch ? jsonMatch[1] : response;
      return JSON.parse(jsonStr.trim());
    } catch (error) {
      throw new Error(
        `Failed to parse JSON response: ${error instanceof Error ? error.message : String(error)}\nResponse: ${response}`
      );
    }
  }

  /**
   * 记录日志
   */
  protected log(level: 'info' | 'warn' | 'error', message: string, data?: any) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      role: this.role,
      level,
      message,
      data,
    };
    console.log(JSON.stringify(logEntry));
  }

  /**
   * 验证输入
   */
  protected validateInput(input: any, requiredFields: string[]): void {
    for (const field of requiredFields) {
      if (!(field in input) || input[field] === undefined || input[field] === null) {
        throw new Error(`Missing required field: ${field}`);
      }
    }
  }
}

/**
 * 创建智能体消息
 */
export function createAgentMessage(
  from: AgentRole,
  to: AgentRole | 'orchestrator',
  type: AgentMessage['type'],
  payload: any,
  request_id: string
): AgentMessage {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    from,
    to,
    type,
    payload,
    timestamp: Date.now(),
    request_id,
  };
}
