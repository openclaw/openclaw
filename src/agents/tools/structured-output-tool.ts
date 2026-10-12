import { parseJsonPreservingUnsafeIntegers } from "@openclaw/ai/transports";
import { Type } from "typebox";
import { validateJsonSchemaValue } from "../../plugins/schema-validator.js";
import type { JsonSchemaObject } from "../../shared/json-schema.types.js";
import type { SwarmStructuredOutputState } from "../subagents/registry/subagent-registry.types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";

const states = new Map<string, SwarmStructuredOutputState>();
const pendingExecutions = new Map<string, Promise<unknown>>();

export function peekSwarmStructuredOutput(runId: string): SwarmStructuredOutputState | undefined {
  const state = states.get(runId);
  return state ? structuredClone(state) : undefined;
}

export function consumeSwarmStructuredOutput(
  runId: string,
): SwarmStructuredOutputState | undefined {
  const state = peekSwarmStructuredOutput(runId);
  states.delete(runId);
  return state;
}

export function createStructuredOutputTool(params: {
  runId: string;
  schema: Record<string, unknown>;
  initialState?: SwarmStructuredOutputState;
  onStateChange?: (state: SwarmStructuredOutputState) => void | Promise<void>;
}): AnyAgentTool {
  const requestedSchema = JSON.stringify(params.schema);
  if (params.initialState && !states.has(params.runId)) {
    states.set(params.runId, structuredClone(params.initialState));
  }
  const commitState = async (next: SwarmStructuredOutputState) => {
    try {
      await params.onStateChange?.(structuredClone(next));
    } catch (error) {
      throw new ToolInputError(
        `Failed to persist structured_output: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    states.set(params.runId, next);
  };
  return {
    label: "Structured Output",
    name: "structured_output",
    // Per-run collector contract: must be callable without discovery, and its
    // schema-dump description would only pollute the search index.
    catalogMode: "direct-only",
    displaySummary: "Record the collector result.",
    description: `Call exactly once as {"result": ...}, where result matches this JSON Schema: ${requestedSchema}`,
    // Runtime argument validation must reach execute so invalid attempts consume
    // the durable one-retry budget. Providers still require every tool property to
    // declare a JSON type before they will send the request.
    parameters: Type.Object(
      {
        result: Type.Unsafe({
          type: ["object", "array", "string", "number", "boolean", "null"],
        }),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, args) => {
      const previous = pendingExecutions.get(params.runId) ?? Promise.resolve();
      const execution = previous
        .catch(() => {})
        .then(async () => {
          const prior = states.get(params.runId);
          if (prior?.structured !== undefined) {
            throw new ToolInputError("structured_output already recorded for this run");
          }
          if (prior && prior.invalidAttempts >= 2) {
            return jsonResult({
              status: "rejected",
              success: false,
              schemaError: prior.schemaError,
            });
          }
          let validation: ReturnType<typeof validateJsonSchemaValue>;
          try {
            const input = {
              schema: params.schema as JsonSchemaObject,
              cacheKey: `swarm-structured-output:${params.runId}`,
              value: (args as { result: unknown }).result,
            };
            validation = validateJsonSchemaValue(input);
            // Preserve valid string results; decode only a rejected nested JSON string.
            if (!validation.ok && typeof input.value === "string") {
              try {
                const decoded = validateJsonSchemaValue({
                  ...input,
                  value: parseJsonPreservingUnsafeIntegers(input.value),
                });
                if (decoded.ok) {
                  validation = decoded;
                }
              } catch {
                // Keep the original validation error when the string is not JSON.
              }
            }
          } catch (error) {
            throw new ToolInputError(
              `Invalid sessions_spawn outputSchema: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          if (validation.ok) {
            await commitState({ structured: validation.value, invalidAttempts: 0 });
            return jsonResult({ status: "recorded" });
          }
          const invalidAttempts = (prior?.invalidAttempts ?? 0) + 1;
          const schemaError = validation.errors
            .slice(0, 3)
            .map((error) => error.text)
            .join("; ");
          await commitState({ structured: undefined, invalidAttempts, schemaError });
          if (invalidAttempts === 1) {
            throw new ToolInputError(
              `structured_output validation failed: ${schemaError}. Retry once with a corrected final result.`,
            );
          }
          return jsonResult({ status: "rejected", success: false, schemaError });
        });
      pendingExecutions.set(params.runId, execution);
      try {
        return await execution;
      } finally {
        if (pendingExecutions.get(params.runId) === execution) {
          pendingExecutions.delete(params.runId);
        }
      }
    },
  };
}
