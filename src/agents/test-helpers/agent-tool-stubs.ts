/**
 * Agent tool stub helpers for tests.
 *
 * Builds no-op tool inventory entries when tests only need schema and naming shape.
 */
import { Type } from "typebox";
import type { ClientToolDefinition } from "../embedded-agent-runner/run/params.js";
import type { AgentTool, AgentToolResult } from "../runtime/index.js";

/** Creates a no-op tool with an empty object schema. */
export function createStubTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: "",
    parameters: Type.Object({}),
    execute: async () => ({}) as AgentToolResult<unknown>,
  };
}

export const createClientToolDefinition = (name: string): ClientToolDefinition => ({
  type: "function",
  function: { name, parameters: { type: "object", properties: {} } },
});
