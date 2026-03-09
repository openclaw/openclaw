/**
 * Chain Memory Backend - 配置验证器
 *
 * 使用 Zod schema 校验器自动验证配置的正确性
 *
 * @module config-validator
 * @author Tutu
 * @date 2026-03-09
 */

import { z } from "zod";

/**
 * Priority 类型定义
 */
const PrioritySchema = z.enum(["primary", "secondary", "fallback"], {
  message: "priority must be one of: primary, secondary, fallback",
});

/**
 * Backend 类型定义（不能是 chain）
 */
const BackendSchema = z.enum(["builtin", "qmd"], {
  message: "backend must be one of: builtin, qmd",
});

/**
 * 超时配置
 */
const TimeoutSchema = z
  .object({
    add: z
      .number()
      .positive({ message: "timeout.add must be positive" })
      .max(60000, { message: "timeout.add must be less than 60000ms" })
      .optional(),
    search: z
      .number()
      .positive({ message: "timeout.search must be positive" })
      .max(60000, { message: "timeout.search must be less than 60000ms" })
      .optional(),
    update: z
      .number()
      .positive({ message: "timeout.update must be positive" })
      .max(60000, { message: "timeout.update must be less than 60000ms" })
      .optional(),
    delete: z
      .number()
      .positive({ message: "timeout.delete must be positive" })
      .max(60000, { message: "timeout.delete must be less than 60000ms" })
      .optional(),
  })
  .optional();

/**
 * 重试配置
 */
const RetrySchema = z
  .object({
    maxAttempts: z
      .number()
      .int({ message: "retry.maxAttempts must be an integer" })
      .positive({ message: "retry.maxAttempts must be positive" })
      .max(10, { message: "retry.maxAttempts must be less than 10" })
      .optional(),
    backoffMs: z
      .number()
      .positive({ message: "retry.backoffMs must be positive" })
      .max(10000, { message: "retry.backoffMs must be less than 10000ms" })
      .optional(),
  })
  .optional();

/**
 * 熔断器配置
 */
const CircuitBreakerSchema = z
  .object({
    failureThreshold: z
      .number()
      .int({ message: "circuitBreaker.failureThreshold must be an integer" })
      .positive({ message: "circuitBreaker.failureThreshold must be positive" })
      .max(100, { message: "circuitBreaker.failureThreshold must be less than 100" })
      .optional(),
    resetTimeoutMs: z
      .number()
      .positive({ message: "circuitBreaker.resetTimeoutMs must be positive" })
      .max(300000, { message: "circuitBreaker.resetTimeoutMs must be less than 300000ms" })
      .optional(),
  })
  .optional();

/**
 * 写入模式
 */
const WriteModeSchema = z
  .enum(["sync", "async"], {
    message: "writeMode must be one of: sync, async",
  })
  .optional();

/**
 * Provider 配置
 *
 * 支持 backend 或 plugin 二选一：
 * - backend: 内置后端（builtin, qmd）
 * - plugin: OpenClaw 插件（@mem9/openclaw, @mem0/openclaw-mem0 等）
 */
const ProviderSchema = z
  .object({
    name: z
      .string()
      .min(1, { message: "provider name cannot be empty" })
      .max(50, { message: "provider name must be less than 50 characters" })
      .regex(/^[a-zA-Z0-9_-]+$/, {
        message: "provider name must be alphanumeric (letters, numbers, underscore, hyphen)",
      }),

    priority: PrioritySchema,

    // backend 或 plugin 二选一
    backend: BackendSchema.optional(),
    plugin: z.string().optional(),

    enabled: z.boolean().optional(),

    timeout: TimeoutSchema,
    retry: RetrySchema,
    circuitBreaker: CircuitBreakerSchema,
    writeMode: WriteModeSchema,
  })
  .passthrough()
  .refine(
    // 验证：backend 或 plugin 必须存在
    (data) => data.backend || data.plugin,
    {
      message: "Either backend or plugin must be specified",
      path: ["backend", "plugin"],
    },
  )
  .refine(
    // 验证：backend 和 plugin 不能同时存在
    (data) => !(data.backend && data.plugin),
    {
      message: "Cannot specify both backend and plugin - choose one",
      path: ["backend", "plugin"],
    },
  );

/**
 * 全局配置
 */
const GlobalConfigSchema = z
  .object({
    defaultTimeout: z
      .number()
      .positive({ message: "global.defaultTimeout must be positive" })
      .max(60000, { message: "global.defaultTimeout must be less than 60000ms" })
      .optional(),

    enableAsyncWrite: z.boolean().optional(),
    enableFallback: z.boolean().optional(),

    healthCheckInterval: z
      .number()
      .positive({ message: "global.healthCheckInterval must be positive" })
      .max(300000, { message: "global.healthCheckInterval must be less than 300000ms" })
      .optional(),
  })
  .optional();

/**
 * Chain 配置 Schema
 */
const ChainConfigSchema = z.object({
  providers: z.array(ProviderSchema).min(1, { message: "at least one provider required" }),

  global: GlobalConfigSchema,
});

/**
 * 验证结果类型
 */
export interface ValidationResult {
  providers: unknown[];
  global: {
    defaultTimeout: number;
    enableAsyncWrite: boolean;
    enableFallback: boolean;
    healthCheckInterval: number;
  };
  warnings: string[];
}

/**
 * 验证错误类
 */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

/**
 * 验证 Chain 配置
 *
 * @param config - 配置对象
 * @returns 验证结果（包含默认值）
 * @throws ConfigValidationError - 如果配置无效
 *
 * @example
 * ```typescript
 * const config = {
 *   providers: [
 *     { name: 'primary', priority: 'primary', backend: 'builtin' }
 *   ]
 * };
 *
 * const result = validateChainConfig(config);
 * console.log(result.global.defaultTimeout); // 5000
 * ```
 */
export function validateChainConfig(config: unknown): ValidationResult {
  // 1. Zod schema 验证
  let parsed: z.infer<typeof ChainConfigSchema>;

  try {
    parsed = ChainConfigSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      // 提取第一个错误信息
      const firstError = error.issues[0];
      throw new ConfigValidationError(firstError.message);
    }
    throw error;
  }

  // 2. 自定义验证逻辑
  const warnings: string[] = [];

  // 检查名称唯一性
  const names = parsed.providers.map((p) => p.name);
  const uniqueNames = new Set(names);
  if (uniqueNames.size !== names.length) {
    // 找出重复的名称
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    throw new ConfigValidationError(
      `provider names must be unique, duplicate: ${duplicates.join(", ")}`,
    );
  }

  // 检查至少一个 enabled provider
  const enabledProviders = parsed.providers.filter((p) => p.enabled !== false);
  if (enabledProviders.length === 0) {
    throw new ConfigValidationError("at least one enabled provider required");
  }

  // 检查只有一个 primary（在 enabled providers 中）
  const primaryProviders = enabledProviders.filter((p) => p.priority === "primary");
  if (primaryProviders.length > 1) {
    throw new ConfigValidationError("only one primary provider allowed");
  }
  if (primaryProviders.length === 0) {
    throw new ConfigValidationError("at least one primary provider required");
  }

  // 检查 primary 不能嵌套 chain
  const chainBackends = parsed.providers.filter((p) => (p.backend as string) === "chain");
  if (chainBackends.length > 0) {
    throw new ConfigValidationError("chain backend cannot be nested");
  }

  // 警告：primary 使用 async writeMode
  const primary = primaryProviders[0];
  if (primary && primary.writeMode === "async") {
    warnings.push("primary provider with async writeMode may cause data inconsistency");
  }

  // 警告：没有 fallback
  const fallbackProviders = parsed.providers.filter((p) => p.priority === "fallback");
  if (fallbackProviders.length === 0 && parsed.global?.enableFallback !== false) {
    warnings.push("no fallback provider configured, system may fail if primary fails");
  }

  // 3. 应用默认值
  const global = {
    defaultTimeout: parsed.global?.defaultTimeout ?? 5000,
    enableAsyncWrite: parsed.global?.enableAsyncWrite ?? true,
    enableFallback: parsed.global?.enableFallback ?? true,
    healthCheckInterval: parsed.global?.healthCheckInterval ?? 30000,
  };

  // 4. 为每个 provider 应用默认值
  const providers = parsed.providers.map((p) => ({
    ...p,
    enabled: p.enabled ?? true,
    timeout: {
      add: p.timeout?.add ?? global.defaultTimeout,
      search: p.timeout?.search ?? global.defaultTimeout,
      update: p.timeout?.update ?? global.defaultTimeout,
      delete: p.timeout?.delete ?? global.defaultTimeout,
    },
    retry: {
      maxAttempts: p.retry?.maxAttempts ?? 3,
      backoffMs: p.retry?.backoffMs ?? 1000,
    },
    circuitBreaker: {
      failureThreshold: p.circuitBreaker?.failureThreshold ?? 5,
      resetTimeoutMs: p.circuitBreaker?.resetTimeoutMs ?? 60000,
    },
    writeMode:
      p.writeMode ?? (p.priority === "primary" || p.priority === "fallback" ? "sync" : "async"),
  }));

  return {
    providers,
    global,
    warnings,
  };
}

/**
 * 导出类型和 schema
 */
export { ChainConfigSchema, ProviderSchema, PrioritySchema, BackendSchema };
