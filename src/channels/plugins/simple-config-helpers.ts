import { z } from "zod";
import type { ChannelConfigSchema } from "./types.plugin.js";

/**
 * Simplified account configuration for channels that don't need complex schemas.
 * This is a generic record type that can hold any account-specific properties.
 */
export type SimpleChannelAccountConfig = Record<string, unknown>;

/**
 * Options for building a simple channel configuration schema.
 */
export type BuildSimpleChannelConfigSchemaOptions = {
  /**
   * Additional properties for account configuration.
   * These will be merged into the account schema.
   */
  accountProperties?: Record<string, unknown>;
  /**
   * Whether the channel supports multiple accounts (default: true).
   * Set to false for single-account channels.
   */
  supportsMultipleAccounts?: boolean;
};

/**
 * Builds a basic channel configuration schema for simple use cases.
 *
 * This helper function creates a standard JSON Schema for channel configuration
 * with minimal setup. It's ideal for channels that don't need complex validation
 * or nested structures.
 *
 * @example
 * ```typescript
 * // Basic usage
 * const schema = buildSimpleChannelConfigSchema();
 *
 * // With custom account properties
 * const schema = buildSimpleChannelConfigSchema({
 *   accountProperties: {
 *     apiKey: { type: "string" },
 *     region: { type: "string", enum: ["us", "eu", "asia"] }
 *   }
 * });
 * ```
 *
 * @param options - Configuration options for the schema
 * @returns A ChannelConfigSchema object suitable for channel registration
 */
export function buildSimpleChannelConfigSchema(
  options?: BuildSimpleChannelConfigSchemaOptions,
): ChannelConfigSchema {
  const { accountProperties = {}, supportsMultipleAccounts = true } = options ?? {};

  // Base account schema with enabled flag
  const accountSchema: Record<string, unknown> = {
    type: "object",
    properties: {
      enabled: {
        type: "boolean",
        description: "Whether this account is enabled",
        default: true,
      },
      ...accountProperties,
    },
    additionalProperties: true,
  };

  // Full channel schema
  const schema: Record<string, unknown> = {
    type: "object",
    properties: {
      enabled: {
        type: "boolean",
        description: "Whether the channel is enabled globally",
      },
      ...(supportsMultipleAccounts
        ? {
            accounts: {
              type: "object",
              description: "Account-specific configurations",
              additionalProperties: accountSchema,
            },
          }
        : {
            // For single-account channels, flatten account properties to top level
            ...accountProperties,
          }),
    },
    additionalProperties: true,
  };

  return {
    schema,
    uiHints: {
      enabled: {
        label: "Enable Channel",
        help: "Enable or disable this channel globally",
      },
      ...(supportsMultipleAccounts
        ? {
            accounts: {
              label: "Accounts",
              help: "Configure one or more accounts for this channel",
            },
          }
        : {}),
    },
  };
}

/**
 * Helper to create a simple Zod-based channel configuration schema.
 *
 * For channels that prefer using Zod for schema definition, this helper
 * converts a Zod schema to the JSON Schema format required by OpenClaw.
 *
 * @example
 * ```typescript
 * import { z } from "zod";
 *
 * const accountSchema = z.object({
 *   apiKey: z.string().min(1),
 *   region: z.enum(["us", "eu", "asia"]),
 *   enabled: z.boolean().default(true)
 * });
 *
 * const configSchema = buildSimpleZodChannelConfigSchema(accountSchema);
 * ```
 *
 * @param accountSchema - Zod schema for account configuration
 * @returns A ChannelConfigSchema object
 */
export function buildSimpleZodChannelConfigSchema(
  accountSchema: z.ZodTypeAny,
): ChannelConfigSchema {
  const jsonSchema = accountSchema.toJSONSchema({
    target: "draft-07",
    unrepresentable: "any",
  }) as Record<string, unknown>;

  return {
    schema: {
      type: "object",
      properties: {
        enabled: {
          type: "boolean",
          description: "Whether the channel is enabled globally",
        },
        accounts: {
          type: "object",
          description: "Account-specific configurations",
          additionalProperties: jsonSchema,
        },
      },
      additionalProperties: true,
    },
    uiHints: {
      enabled: {
        label: "Enable Channel",
        help: "Enable or disable this channel globally",
      },
      accounts: {
        label: "Accounts",
        help: "Configure one or more accounts for this channel",
      },
    },
  };
}
