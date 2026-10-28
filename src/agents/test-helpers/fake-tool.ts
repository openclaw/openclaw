import { vi } from "vitest";
import { jsonResult, type AnyAgentTool } from "../tools/common.js";

export function fakeTool(name: string, description: string): AnyAgentTool {
  return {
    name,
    label: name,
    description,
    parameters: { type: "object", properties: { value: { type: "string" } } },
    execute: vi.fn(async (_toolCallId, input) => jsonResult({ name, input })),
  };
}
