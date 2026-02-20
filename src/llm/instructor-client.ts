import Instructor from "@instructor-ai/instructor";
import OpenAI from "openai";
import { z } from "zod";
import { HELICONE_BASE_URL, createHeliconeHeaders } from "../helicone-config.js";

/**
 * Instructor Client — Phase 1: Foundation
 *
 * Provides structured LLM outputs with automatic validation and retry logic.
 * Integrates with Helicone for observability.
 */

// ============================================================================
// Configuration
// ============================================================================

export interface InstructorConfig {
  model?: string;
  maxRetries?: number;
  timeoutMs?: number;
  temperature?: number;
  enableHelicone?: boolean;
  userId?: string;
  sessionId?: string;
}

const DEFAULT_CONFIG: Required<InstructorConfig> = {
  model: "gpt-4o",
  maxRetries: 3,
  timeoutMs: 60000,
  temperature: 0.7,
  enableHelicone: true,
  userId: "anonymous",
  sessionId: "default",
};

// ============================================================================
// Client Factory
// ============================================================================

/**
 * Create an OpenAI client with optional Helicone proxy
 */
function createOpenAIClient(config: InstructorConfig): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is required");
  }

  if (config.enableHelicone && process.env.HELICONE_API_KEY) {
    return new OpenAI({
      apiKey,
      baseURL: HELICONE_BASE_URL,
      defaultHeaders: createHeliconeHeaders(config.userId, config.sessionId),
      timeout: config.timeoutMs,
    });
  }

  return new OpenAI({
    apiKey,
    timeout: config.timeoutMs,
  });
}

/**
 * Create an Instructor client for structured outputs
 */
export function createInstructorClient(config: InstructorConfig = {}) {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const openai = createOpenAIClient(mergedConfig);

  return Instructor({
    client: openai,
    mode: "TOOLS",
  });
}

// ============================================================================
// Structured Generation
// ============================================================================

export interface GenerateOptions<T extends z.ZodTypeAny> {
  /** Zod schema for output validation */
  schema: T;
  /** Schema name (for function calling) */
  schemaName?: string;
  /** System prompt/instructions */
  system?: string;
  /** User prompt/message */
  prompt: string;
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Override model */
  model?: string;
  /** Override temperature */
  temperature?: number;
  /** Override max retries */
  maxRetries?: number;
  /** Optional message history */
  messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

/**
 * Generate structured output using Instructor with automatic validation
 */
export async function generateStructured<T extends z.ZodTypeAny>(
  options: GenerateOptions<T>,
  clientConfig: InstructorConfig = {},
): Promise<z.infer<T>> {
  const instructor = createInstructorClient(clientConfig);
  const schemaName = options.schemaName || "StructuredOutput";

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];

  if (options.system) {
    messages.push({ role: "system", content: options.system });
  }

  if (options.messages) {
    messages.push(...options.messages);
  }

  messages.push({ role: "user", content: options.prompt });

  const maxRetries = options.maxRetries ?? clientConfig.maxRetries ?? DEFAULT_CONFIG.maxRetries;

  return await instructor.chat.completions.create({
    model: options.model ?? clientConfig.model ?? DEFAULT_CONFIG.model,
    messages,
    response_model: {
      name: schemaName,
      schema: options.schema,
    },
    max_retries: maxRetries,
    temperature: options.temperature ?? clientConfig.temperature ?? DEFAULT_CONFIG.temperature,
    max_tokens: options.maxTokens,
  });
}

/**
 * Generate with retry logic and error recovery
 */
export async function generateWithFallback<T extends z.ZodTypeAny>(
  options: GenerateOptions<T>,
  clientConfig: InstructorConfig = {},
  fallbackModels: string[] = ["gpt-4o-mini", "claude-3-haiku-20240307"],
): Promise<z.infer<T>> {
  const errors: Error[] = [];

  // Try primary model first
  try {
    return await generateStructured(options, clientConfig);
  } catch (error) {
    errors.push(error as Error);
  }

  // Try fallback models
  for (const fallbackModel of fallbackModels) {
    try {
      return await generateStructured(
        { ...options, model: fallbackModel, maxRetries: 1 },
        clientConfig,
      );
    } catch (error) {
      errors.push(error as Error);
    }
  }

  throw new Error(`All models failed. Errors: ${errors.map((e) => e.message).join("; ")}`);
}

// ============================================================================
// Streaming Support
// ============================================================================

export interface StreamOptions<T extends z.ZodTypeAny> extends GenerateOptions<T> {
  onPartial?: (partial: Partial<z.infer<T>>) => void;
}

/**
 * Generate structured output with streaming support
 * Note: Instructor doesn't natively support streaming with validation,
 * so this yields partial results for UI feedback
 */
export async function* generateStreaming<T extends z.ZodTypeAny>(
  options: StreamOptions<T>,
  clientConfig: InstructorConfig = {},
): AsyncGenerator<Partial<z.infer<T>>> {
  const openai = createOpenAIClient(clientConfig);

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];

  if (options.system) {
    messages.push({ role: "system", content: options.system });
  }

  messages.push({ role: "user", content: options.prompt });

  const stream = await openai.chat.completions.create({
    model: options.model ?? clientConfig.model ?? DEFAULT_CONFIG.model,
    messages,
    stream: true,
    temperature: options.temperature ?? clientConfig.temperature ?? DEFAULT_CONFIG.temperature,
    max_tokens: options.maxTokens,
  });

  let accumulated = "";

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content;
    if (content) {
      accumulated += content;

      // Try to parse partial JSON (best effort)
      try {
        const partial = JSON.parse(accumulated);
        yield partial;
        options.onPartial?.(partial);
      } catch {
        // Partial JSON, continue accumulating
      }
    }
  }
}

// ============================================================================
// Batch Processing
// ============================================================================

export interface BatchItem<T extends z.ZodTypeAny> {
  id: string;
  options: GenerateOptions<T>;
}

export interface BatchResult<T> {
  id: string;
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * Process multiple structured generation requests
 */
export async function generateBatch<T extends z.ZodTypeAny>(
  items: BatchItem<T>[],
  clientConfig: InstructorConfig = {},
  concurrency: number = 3,
): Promise<BatchResult<z.infer<T>>[]> {
  const results: BatchResult<z.infer<T>>[] = [];

  // Process in batches to control concurrency
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);

    const batchPromises = batch.map(async (item) => {
      try {
        const data = await generateStructured(item.options, clientConfig);
        return { id: item.id, success: true, data };
      } catch (error) {
        return {
          id: item.id,
          success: false,
          error: (error as Error).message,
        };
      }
    });

    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
  }

  return results;
}
