/**
 * Agent-to-agent typed message contracts.
 *
 * Allows agents to declare typed message schemas (contracts) that describe
 * structured interactions they support. Other agents can discover these
 * contracts and send structured payloads that are validated before delivery.
 *
 * Contracts are declared per-agent in config:
 * ```json5
 * {
 *   agents: {
 *     list: [{
 *       id: "research-bot",
 *       a2a: {
 *         contracts: {
 *           "research.request": {
 *             description: "Submit a research query",
 *             input: {
 *               type: "object",
 *               properties: {
 *                 query: { type: "string", description: "Research query" },
 *                 depth: { type: "string", enum: ["shallow", "deep"] }
 *               },
 *               required: ["query"]
 *             },
 *             output: {
 *               type: "object",
 *               properties: {
 *                 findings: { type: "string" },
 *                 sources: { type: "array", items: { type: "string" } }
 *               }
 *             }
 *           }
 *         }
 *       }
 *     }]
 *   }
 * }
 * ```
 */

import type { OpenClawConfig } from "../../config/config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** JSON Schema subset for contract validation. */
export type ContractSchema = {
  type?: string;
  properties?: Record<string, ContractSchema>;
  required?: string[];
  description?: string;
  items?: ContractSchema;
  enum?: unknown[];
  default?: unknown;
  [key: string]: unknown;
};

/** A declared agent-to-agent message contract. */
export type A2AContract = {
  /** Human-readable description of what this contract does. */
  description?: string;
  /** Schema for the input payload the agent expects. */
  input?: ContractSchema;
  /** Schema for the output payload the agent returns. */
  output?: ContractSchema;
  /** Whether this contract requires approval from the target agent's owner. */
  requiresApproval?: boolean;
  /** Version of this contract (semver or simple string like "1", "2"). */
  version?: string;
  /** Whether this contract is deprecated. */
  deprecated?: boolean;
  /** Human-readable deprecation message. */
  deprecatedMessage?: string;
  /** Contract name that supersedes this one. */
  supersededBy?: string;
};

/** Per-agent A2A configuration. */
export type AgentA2AConfig = {
  /** Typed message contracts this agent supports. */
  contracts?: Record<string, A2AContract>;
  /** Whether this agent accepts untyped (free-form) messages. Default: true. */
  allowFreeform?: boolean;
};

/** Validation result for a contract payload. */
export type ContractValidationResult = {
  valid: boolean;
  errors: string[];
  /** Advisory warnings (e.g., deprecated contract). */
  warnings: string[];
};

/** A resolved contract reference for cross-agent calls. */
export type ResolvedContract = {
  agentId: string;
  contractName: string;
  contract: A2AContract;
};

// ---------------------------------------------------------------------------
// Contract discovery
// ---------------------------------------------------------------------------

/**
 * Discover all A2A contracts from the config.
 * Returns a flat list of resolved contracts across all agents.
 */
export function discoverContracts(cfg: OpenClawConfig): ResolvedContract[] {
  const agents = cfg.agents?.list;
  if (!agents || !Array.isArray(agents)) {
    return [];
  }

  const contracts: ResolvedContract[] = [];
  for (const agent of agents) {
    const agentId = agent.id;
    const a2aConfig = (agent as Record<string, unknown>).a2a as AgentA2AConfig | undefined;
    if (!agentId || !a2aConfig?.contracts) {
      continue;
    }

    for (const [name, contract] of Object.entries(a2aConfig.contracts)) {
      contracts.push({ agentId, contractName: name, contract });
    }
  }

  return contracts;
}

/**
 * Find a specific contract for an agent.
 */
export function findContract(
  cfg: OpenClawConfig,
  agentId: string,
  contractName: string,
): ResolvedContract | undefined {
  return discoverContracts(cfg).find(
    (c) => c.agentId === agentId && c.contractName === contractName,
  );
}

/**
 * List all contracts for a specific agent.
 */
export function listAgentContracts(cfg: OpenClawConfig, agentId: string): ResolvedContract[] {
  return discoverContracts(cfg).filter((c) => c.agentId === agentId);
}

/**
 * List all deprecated contracts across all agents.
 */
export function listDeprecatedContracts(cfg: OpenClawConfig): ResolvedContract[] {
  return discoverContracts(cfg).filter((c) => c.contract.deprecated === true);
}

// ---------------------------------------------------------------------------
// Deprecation helpers
// ---------------------------------------------------------------------------

/**
 * Collect deprecation warnings for a contract.
 */
function collectDeprecationWarnings(contract: A2AContract): string[] {
  if (!contract.deprecated) {
    return [];
  }

  const warnings: string[] = [];
  const msg = contract.deprecatedMessage ?? "This contract is deprecated.";
  warnings.push(msg);

  if (contract.supersededBy) {
    warnings.push(`Use "${contract.supersededBy}" instead.`);
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Contract validation
// ---------------------------------------------------------------------------

/**
 * Validate a payload against a contract's input schema.
 * Performs basic JSON Schema validation (type checks, required fields, enums).
 */
export function validateContractInput(
  contract: A2AContract,
  payload: unknown,
): ContractValidationResult {
  const warnings = collectDeprecationWarnings(contract);
  if (!contract.input) {
    return { valid: true, errors: [], warnings };
  }
  const result = validateAgainstSchema(contract.input, payload, "input");
  return { ...result, warnings: [...warnings, ...result.warnings] };
}

/**
 * Validate a response against a contract's output schema.
 */
export function validateContractOutput(
  contract: A2AContract,
  payload: unknown,
): ContractValidationResult {
  const warnings = collectDeprecationWarnings(contract);
  if (!contract.output) {
    return { valid: true, errors: [], warnings };
  }
  const result = validateAgainstSchema(contract.output, payload, "output");
  return { ...result, warnings: [...warnings, ...result.warnings] };
}

// ---------------------------------------------------------------------------
// Schema validation (lightweight, no external deps)
// ---------------------------------------------------------------------------

function validateAgainstSchema(
  schema: ContractSchema,
  value: unknown,
  path: string,
): ContractValidationResult {
  const errors: string[] = [];

  if (schema.type) {
    const typeValid = checkType(schema.type, value);
    if (!typeValid) {
      errors.push(`${path}: expected type "${schema.type}", got ${typeof value}`);
      return { valid: false, errors, warnings: [] };
    }
  }

  if (schema.enum && Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value)) {
      errors.push(`${path}: value must be one of [${schema.enum.join(", ")}]`);
    }
  }

  // String constraints.
  if (typeof value === "string") {
    const minLen = schema.minLength as number | undefined;
    const maxLen = schema.maxLength as number | undefined;
    const pattern = schema.pattern as string | undefined;
    if (minLen !== undefined && value.length < minLen) {
      errors.push(`${path}: string length ${value.length} is below minimum ${minLen}`);
    }
    if (maxLen !== undefined && value.length > maxLen) {
      errors.push(`${path}: string length ${value.length} exceeds maximum ${maxLen}`);
    }
    if (pattern) {
      try {
        if (!new RegExp(pattern).test(value)) {
          errors.push(`${path}: string does not match pattern "${pattern}"`);
        }
      } catch {
        // Invalid regex in schema — skip silently.
      }
    }
  }

  // Numeric constraints.
  if (typeof value === "number") {
    const min = schema.minimum as number | undefined;
    const max = schema.maximum as number | undefined;
    if (min !== undefined && value < min) {
      errors.push(`${path}: value ${value} is below minimum ${min}`);
    }
    if (max !== undefined && value > max) {
      errors.push(`${path}: value ${value} exceeds maximum ${max}`);
    }
  }

  if (schema.type === "object" && typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;

    // Check required fields.
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) {
          errors.push(`${path}.${key}: required field missing`);
        }
      }
    }

    // Reject extra properties when additionalProperties is false.
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(obj)) {
        if (!(key in schema.properties)) {
          errors.push(`${path}.${key}: unknown property (additionalProperties is false)`);
        }
      }
    }

    // Validate properties.
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          const propResult = validateAgainstSchema(propSchema, obj[key], `${path}.${key}`);
          errors.push(...propResult.errors);
        }
      }
    }
  }

  // Array constraints.
  if (schema.type === "array" && Array.isArray(value)) {
    const minItems = schema.minItems as number | undefined;
    const maxItems = schema.maxItems as number | undefined;
    if (minItems !== undefined && value.length < minItems) {
      errors.push(`${path}: array length ${value.length} is below minimum ${minItems}`);
    }
    if (maxItems !== undefined && value.length > maxItems) {
      errors.push(`${path}: array length ${value.length} exceeds maximum ${maxItems}`);
    }
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const itemResult = validateAgainstSchema(schema.items, value[i], `${path}[${i}]`);
        errors.push(...itemResult.errors);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings: [] };
}

function checkType(expected: string, value: unknown): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
    case "integer":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (expected === "number" || Number.isInteger(value))
      );
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Structured A2A message format
// ---------------------------------------------------------------------------

/** A structured A2A message that wraps a contract invocation. */
export type A2AStructuredMessage = {
  /** Protocol marker. */
  _a2a: true;
  /** Contract name being invoked. */
  contract: string;
  /** Payload matching the contract's input schema. */
  payload: unknown;
  /** Optional correlation ID for tracking multi-turn exchanges. */
  correlationId?: string;
};

/**
 * Create a structured A2A message.
 */
export function createA2AMessage(
  contractName: string,
  payload: unknown,
  correlationId?: string,
): A2AStructuredMessage {
  return {
    _a2a: true,
    contract: contractName,
    payload,
    ...(correlationId ? { correlationId } : {}),
  };
}

/**
 * Check if a message string contains a structured A2A payload.
 * Returns the parsed message or null.
 */
export function parseA2AMessage(message: string): A2AStructuredMessage | null {
  try {
    const parsed = JSON.parse(message);
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed._a2a === true &&
      typeof parsed.contract === "string" &&
      "payload" in parsed
    ) {
      return parsed as A2AStructuredMessage;
    }
  } catch {
    // Not a structured A2A message — that's fine.
  }
  return null;
}
