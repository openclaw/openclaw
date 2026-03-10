/**
 * Chain Memory Backend - Configuration Validator
 *
 * Use Zod schema validator to automatically validate configuration
 *
 * @module config-validator
 * @author Tutu
 * @date 2026-03-09
 */

import { z } from "zod";

/**
 * Priority type definition
 */
const PrioritySchema = z.enum(["primary", "secondary", "fallback"], {
  message: "priority must be one of: primary, secondary, fallback",
});

/**
 * Backend type definition (cannot be chain)
 */
const BackendSchema = z.enum(["builtin", "qmd"], {
  message: "backend must be one of: builtin, qmd",
});

/**
 * Timeout configuration
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
 * Retry configuration
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
 * Circuit breaker configuration
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
 * Provider configuration
 *
 * Supports backend or plugin (mutually exclusive):
 * - backend: Built-in backends (builtin, qmd)
 * - plugin: OpenClaw plugins (@mem9/openclaw, @mem0/openclaw-mem0, etc.)
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

    // backend or plugin (mutually exclusive)
    backend: BackendSchema.optional(),
    plugin: z.string().optional(),

    enabled: z.boolean().optional(),

    timeout: TimeoutSchema,
    retry: RetrySchema,
    circuitBreaker: CircuitBreakerSchema,
  })
  .passthrough()
  .refine(
    // Validate: backend or plugin must exist
    (data) => data.backend || data.plugin,
    {
      message: "Either backend or plugin must be specified",
      path: ["backend", "plugin"],
    },
  )
  .refine(
    // Validate: backend and plugin cannot both exist
    (data) => !(data.backend && data.plugin),
    {
      message: "Cannot specify both backend and plugin - choose one",
      path: ["backend", "plugin"],
    },
  );

/**
 * Global configuration
 */
const GlobalConfigSchema = z
  .object({
    defaultTimeout: z
      .number()
      .positive({ message: "global.defaultTimeout must be positive" })
      .max(60000, { message: "global.defaultTimeout must be less than 60000ms" })
      .optional(),

    enableFallback: z.boolean().optional(),

    healthCheckInterval: z
      .number()
      .positive({ message: "global.healthCheckInterval must be positive" })
      .max(300000, { message: "global.healthCheckInterval must be less than 300000ms" })
      .optional(),
  })
  .optional();

/**
 * Chain configuration Schema
 */
const ChainConfigSchema = z.object({
  providers: z.array(ProviderSchema).min(1, { message: "at least one provider required" }),

  global: GlobalConfigSchema,
});

/**
 * Validation result type
 */
export interface ValidationResult {
  providers: z.infer<typeof ProviderSchema>[];
  global: {
    defaultTimeout: number;
    enableFallback: boolean;
    healthCheckInterval: number;
  };
  warnings: string[];
}

/**
 * Validation error class
 */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

/**
 * Validate Chain configuration
 *
 * @param config - Configuration object
 * @returns Validation result (including defaults)
 * @throws ConfigValidationError - If configuration is invalid
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
  // 1. Zod schema validation
  let parsed: z.infer<typeof ChainConfigSchema>;

  try {
    parsed = ChainConfigSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      // Extract first error message
      const firstError = error.issues[0];
      throw new ConfigValidationError(firstError.message);
    }
    throw error;
  }

  // 2. Custom validation logic
  const warnings: string[] = [];

  // Check name uniqueness
  const names = parsed.providers.map((p) => p.name);
  const uniqueNames = new Set(names);
  if (uniqueNames.size !== names.length) {
    // Find duplicate names
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    throw new ConfigValidationError(
      `provider names must be unique, duplicate: ${duplicates.join(", ")}`,
    );
  }

  // Check at least one enabled provider
  const enabledProviders = parsed.providers.filter((p) => p.enabled !== false);
  if (enabledProviders.length === 0) {
    throw new ConfigValidationError("at least one enabled provider required");
  }

  // Check only one primary (among enabled providers)
  const primaryProviders = enabledProviders.filter((p) => p.priority === "primary");
  if (primaryProviders.length > 1) {
    throw new ConfigValidationError("only one primary provider allowed");
  }
  if (primaryProviders.length === 0) {
    throw new ConfigValidationError("at least one primary provider required");
  }

  // Check primary cannot nest chain
  const chainBackends = parsed.providers.filter((p) => (p.backend as string) === "chain");
  if (chainBackends.length > 0) {
    throw new ConfigValidationError("chain backend cannot be nested");
  }

  // Warning: no fallback
  const fallbackProviders = parsed.providers.filter((p) => p.priority === "fallback");
  if (fallbackProviders.length === 0 && parsed.global?.enableFallback !== false) {
    warnings.push("no fallback provider configured, system may fail if primary fails");
  }

  // 3. Apply defaults
  const global = {
    defaultTimeout: parsed.global?.defaultTimeout ?? 5000,
    enableFallback: parsed.global?.enableFallback ?? true,
    healthCheckInterval: parsed.global?.healthCheckInterval ?? 30000,
  };

  // 4. Apply defaults for each provider
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
  }));

  return {
    providers,
    global,
    warnings,
  };
}

/**
 * Export types and schemas
 */
export { ChainConfigSchema, ProviderSchema, PrioritySchema, BackendSchema };
