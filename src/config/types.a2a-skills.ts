/**
 * A2A Skill Declaration Types
 *
 * Skills are declared in agent config and describe what capabilities
 * an agent provides for structured delegation via agent_call / debate_call.
 */

/**
 * JSON Schema-like parameter definition for skill input/output.
 * Simplified subset of JSON Schema for ease of declaration.
 */
export type SkillParameterSchema = {
  /** Parameter type */
  type: "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";
  /** Human-readable description */
  description?: string;
  /** Whether this parameter is required (for object properties) */
  required?: boolean;
  /** Allowed values for string type */
  enum?: string[];
  /** Default value if not provided */
  default?: unknown;
  /** Properties for object type */
  properties?: Record<string, SkillParameterSchema>;
  /** Item schema for array type */
  items?: SkillParameterSchema;
  /** Allow additional properties for object type */
  additionalProperties?: boolean;
  /** Minimum value for number/integer */
  minimum?: number;
  /** Maximum value for number/integer */
  maximum?: number;
  /** Minimum length for string */
  minLength?: number;
  /** Maximum length for string */
  maxLength?: number;
  /** Pattern for string (regex) */
  pattern?: string;
  /** Format hint (e.g., "date", "email", "uri") */
  format?: string;
};

/**
 * A declared skill that an agent can perform.
 *
 * Skills are invoked via agent_call({ agent, skill, input }) and
 * return structured output with optional confidence tracking.
 */
export type SkillDeclaration = {
  /** Skill name - used in agent_call({ skill: "name" }) */
  name: string;
  /** Human-readable description of what this skill does */
  description?: string;
  /** Input parameter schema (keyed by parameter name) */
  input?: Record<string, SkillParameterSchema>;
  /** Output schema (keyed by field name) */
  output?: Record<string, SkillParameterSchema>;
  /** Approximate execution time in seconds (for timeout defaults) */
  timeoutSeconds?: number;
  /** Whether this skill has side effects (writes, mutations) vs read-only */
  sideEffects?: boolean;
  /** Skill mode hints */
  modes?: Array<"execute" | "critique" | "dry-run">;
  /** Examples of valid invocations */
  examples?: Array<{
    input: Record<string, unknown>;
    description?: string;
  }>;
};

/**
 * Built-in skills that every agent implicitly has.
 * These can be overridden by explicit declarations.
 */
export const BUILTIN_SKILLS: SkillDeclaration[] = [
  {
    name: "ping",
    description: "Health check - returns pong if agent is responsive",
    input: {},
    output: {
      status: { type: "string", enum: ["pong"] },
      timestamp: { type: "number", description: "Unix timestamp" },
    },
    timeoutSeconds: 5,
    sideEffects: false,
  },
  {
    name: "list_skills",
    description: "Return all declared skills for this agent",
    input: {},
    output: {
      skills: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string" },
          },
        },
      },
    },
    timeoutSeconds: 5,
    sideEffects: false,
  },
];

/**
 * Skill declarations for an agent.
 */
export type AgentSkillDeclarations = {
  /** Schema version for future compatibility */
  version?: 1;
  /** Declared skills */
  skills: SkillDeclaration[];
};

/**
 * Result of skill validation.
 */
export type SkillValidationResult = { valid: true } | { valid: false; errors: string[] };

/**
 * Validate input against a skill's input schema.
 */
export function validateSkillInput(
  input: Record<string, unknown>,
  schema: Record<string, SkillParameterSchema> | undefined,
): SkillValidationResult {
  if (!schema) {
    return { valid: true };
  }

  const errors: string[] = [];

  // Check required parameters
  for (const [key, param] of Object.entries(schema)) {
    if (param.required && !(key in input)) {
      errors.push(`Missing required parameter: ${key}`);
    }
  }

  // Validate provided values
  for (const [key, value] of Object.entries(input)) {
    const param = schema[key];
    if (!param) {
      // Unknown parameter - allow if no explicit rejection
      continue;
    }

    const typeError = validateType(key, value, param);
    if (typeError) {
      errors.push(typeError);
    }
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true };
}

/**
 * Validate a single value against its parameter schema.
 */
function validateType(key: string, value: unknown, schema: SkillParameterSchema): string | null {
  const actualType = typeof value;

  switch (schema.type) {
    case "string":
      if (actualType !== "string") {
        return `Parameter '${key}' must be string, got ${actualType}`;
      }
      if (schema.enum && !schema.enum.includes(value as string)) {
        return `Parameter '${key}' must be one of: ${schema.enum.join(", ")}`;
      }
      if (schema.minLength && (value as string).length < schema.minLength) {
        return `Parameter '${key}' must be at least ${schema.minLength} characters`;
      }
      if (schema.maxLength && (value as string).length > schema.maxLength) {
        return `Parameter '${key}' must be at most ${schema.maxLength} characters`;
      }
      break;

    case "number":
    case "integer":
      if (actualType !== "number") {
        return `Parameter '${key}' must be number, got ${actualType}`;
      }
      if (schema.type === "integer" && !Number.isInteger(value)) {
        return `Parameter '${key}' must be integer`;
      }
      if (schema.minimum !== undefined && (value as number) < schema.minimum) {
        return `Parameter '${key}' must be >= ${schema.minimum}`;
      }
      if (schema.maximum !== undefined && (value as number) > schema.maximum) {
        return `Parameter '${key}' must be <= ${schema.maximum}`;
      }
      break;

    case "boolean":
      if (actualType !== "boolean") {
        return `Parameter '${key}' must be boolean, got ${actualType}`;
      }
      break;

    case "array":
      if (!Array.isArray(value)) {
        return `Parameter '${key}' must be array, got ${actualType}`;
      }
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          const itemError = validateType(`${key}[${i}]`, value[i], schema.items);
          if (itemError) {
            return itemError;
          }
        }
      }
      break;

    case "object":
      if (actualType !== "object" || value === null || Array.isArray(value)) {
        return `Parameter '${key}' must be object, got ${actualType}`;
      }
      if (schema.properties) {
        for (const [propKey, propSchema] of Object.entries(schema.properties)) {
          if (propKey in (value as Record<string, unknown>)) {
            const propError = validateType(
              `${key}.${propKey}`,
              (value as Record<string, unknown>)[propKey],
              propSchema,
            );
            if (propError) {
              return propError;
            }
          }
        }
      }
      break;

    case "null":
      if (value !== null) {
        return `Parameter '${key}' must be null, got ${actualType}`;
      }
      break;
  }

  return null;
}

/**
 * Generate a human-readable skill invocation prompt.
 * This creates the message sent to the target agent.
 */
export function generateSkillPrompt(
  skill: SkillDeclaration,
  input: Record<string, unknown>,
): string {
  const lines: string[] = [];

  if (skill.description) {
    lines.push(`# Skill: ${skill.name}`);
    lines.push(skill.description);
    lines.push("");
  }

  lines.push("## Input");
  for (const [key, value] of Object.entries(input)) {
    const param = skill.input?.[key];
    const description = param?.description ? ` (${param.description})` : "";
    lines.push(`- **${key}**${description}: ${JSON.stringify(value)}`);
  }

  if (skill.output) {
    lines.push("");
    lines.push("## Expected Output");
    for (const [key, param] of Object.entries(skill.output)) {
      const desc = param.description ? ` - ${param.description}` : "";
      lines.push(`- **${key}** (${param.type})${desc}`);
    }
  }

  return lines.join("\n");
}
