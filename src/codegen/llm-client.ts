/**
 * 通用 LLM 客户端实现
 * 仿照 Crush (opencode) 的方式，使用官方 OpenAI SDK 调用中转服务
 */

import OpenAI from 'openai';
import type { LLMClient } from './base-agent.js';

export type LLMProvider = 'anthropic' | 'openai-compatible';

export interface UniversalLLMConfig {
  provider: LLMProvider;
  apiKey: string;
  baseURL: string;
  model?: string;
  fallbackModels?: string[];
  maxTokens?: number;
  temperature?: number;
  /** 请求超时（毫秒），默认 120s */
  timeout?: number;
}

/**
 * 通用 LLM 客户端 - 使用 OpenAI SDK（和 Crush 一致）
 */
export class UniversalLLMClient implements LLMClient {
  private client: OpenAI;
  private model: string;
  private fallbackModels: string[];
  private maxTokens: number;
  private temperature: number;

  constructor(config: UniversalLLMConfig) {
    this.model = config.model || 'claude-sonnet-4-5-20250929';
    this.fallbackModels = config.fallbackModels || [];
    this.maxTokens = config.maxTokens || 4096;
    this.temperature = config.temperature ?? 0.7;

    if (!config.apiKey) {
      throw new Error('API key is required');
    }

    // 使用 OpenAI SDK，和 Crush 的 openai-compat 模式一致
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: config.timeout || 120_000,
      maxRetries: 3,
    });
  }

  async chat(messages: Array<{ role: string; content: string }>): Promise<string> {
    const modelsToTry = [this.model, ...this.fallbackModels];
    let lastError: Error | null = null;

    for (const model of modelsToTry) {
      try {
        console.log(`[LLM] Trying model: ${model}`);
        const result = await this.callWithModel(messages, model);
        console.log(`[LLM] Success with model: ${model}`);
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`[LLM] Model ${model} failed: ${lastError.message.substring(0, 120)}`);
      }
    }

    throw lastError || new Error('All models failed');
  }

  private async callWithModel(
    messages: Array<{ role: string; content: string }>,
    model: string
  ): Promise<string> {
    const response = await this.client.chat.completions.create({
      model,
      messages: messages as OpenAI.ChatCompletionMessageParam[],
      max_tokens: this.maxTokens,
      temperature: this.temperature,
    });

    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('No content in API response');
    }

    // 记录 token 使用
    if (response.usage) {
      console.log(
        `[LLM] Tokens: ${response.usage.total_tokens} total ` +
        `(${response.usage.prompt_tokens} in, ${response.usage.completion_tokens} out)`
      );
    }

    return content;
  }

  async chatStream(
    messages: Array<{ role: string; content: string }>,
    onChunk: (chunk: string) => void
  ): Promise<string> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages as OpenAI.ChatCompletionMessageParam[],
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream: true,
    });

    let fullContent = '';
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content || '';
      if (delta) {
        fullContent += delta;
        onChunk(delta);
      }
    }

    return fullContent;
  }

  updateConfig(config: Partial<UniversalLLMConfig>): void {
    if (config.model) this.model = config.model;
    if (config.maxTokens) this.maxTokens = config.maxTokens;
    if (config.temperature !== undefined) this.temperature = config.temperature;
    if (config.fallbackModels) this.fallbackModels = config.fallbackModels;

    if (config.apiKey || config.baseURL) {
      this.client = new OpenAI({
        apiKey: config.apiKey || this.client.apiKey,
        baseURL: config.baseURL || this.client.baseURL,
        timeout: config.timeout || 120_000,
        maxRetries: 3,
      });
    }
  }

  getConfig(): UniversalLLMConfig {
    return {
      provider: 'openai-compatible',
      apiKey: this.client.apiKey,
      baseURL: this.client.baseURL,
      model: this.model,
      fallbackModels: this.fallbackModels,
      maxTokens: this.maxTokens,
      temperature: this.temperature,
    };
  }
}

/**
 * 从配置文件创建客户端（仿照 Crush 风格）
 * 优先级：配置文件 > 环境变量
 */
export function createLLMClientFromEnv(): UniversalLLMClient {
  // 1. 尝试从配置文件加载
  try {
    const { loadConfig, getActiveProvider } = require('./config.js');
    const config = loadConfig();
    const { provider, model } = getActiveProvider(config);

    if (provider.api_key) {
      console.log(`[Config] Using provider "${config.models.large.provider}" with model "${model}"`);
      return new UniversalLLMClient({
        provider: 'openai-compatible',
        apiKey: provider.api_key,
        baseURL: provider.base_url || 'https://api.openai.com/v1',
        model,
        maxTokens: config.models.large.max_tokens,
        temperature: config.models.large.temperature,
      });
    }
  } catch {
    // 配置文件不可用，回退到环境变量
  }

  // 2. 环境变量方式
  if (process.env.LLM_BASE_URL && process.env.LLM_API_KEY) {
    const mainModel = process.env.LLM_MODEL || 'claude-sonnet-4-5-20250929';
    console.log(`[Config] Using env vars with model "${mainModel}"`);

    return new UniversalLLMClient({
      provider: 'openai-compatible',
      apiKey: process.env.LLM_API_KEY,
      baseURL: process.env.LLM_BASE_URL,
      model: mainModel,
    });
  }

  // 3. Anthropic 环境变量
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    return new UniversalLLMClient({
      provider: 'anthropic',
      apiKey,
      baseURL: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1',
      model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022',
    });
  }

  throw new Error(
    'No LLM configuration found.\n' +
    'Run: npx tsx src/commands/config.ts\n' +
    'Or set LLM_BASE_URL + LLM_API_KEY environment variables.'
  );
}

// 保持兼容
export const createAnthropicClientFromEnv = createLLMClientFromEnv;
export { UniversalLLMClient as AnthropicLLMClient };
export type { UniversalLLMConfig as AnthropicConfig };
