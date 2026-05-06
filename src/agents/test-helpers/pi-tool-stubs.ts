import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "../agent-core-contract.js";

export function createStubTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: "",
    parameters: Type.Object({}),
    execute: async () => ({}) as AgentToolResult,
  };
}
