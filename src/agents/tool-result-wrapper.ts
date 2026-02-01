import { TextContent } from "@mariozechner/pi-ai";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { encodeToon } from "../utils/toon.js";

const TOON_SENTINEL = "# toon\n";
const MAX_TOON_CHARS = 8_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Wraps a tool to apply TOON encoding to structured data in tool results.
 * This reduces token usage by converting JSON objects to a more compact format
 * before sending them to the model.
 *
 * The wrapper preserves the original `details` object for OpenClaw's internal use
 * but encodes structured content using TOON for the model's consumption.
 */
export function wrapToolWithToonEncoding(tool: AnyAgentTool): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }

  const wrappedExecute = async (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: (update: any) => void,
  ) => {
    const result = await execute(toolCallId, params, signal, onUpdate);

    if ((tool as any).disableToonEncoding) {
      return result;
    }

    if (result?.content && isPlainObject(result.details)) {
      const firstBlock = result.content?.[0];
      const existingText = firstBlock?.type === "text" ? firstBlock.text : undefined;

      if (existingText?.startsWith(TOON_SENTINEL)) {
        return result;
      }

      let toonEncoded = encodeToon(result.details);

      if (toonEncoded.length > MAX_TOON_CHARS) {
        toonEncoded = toonEncoded.slice(0, MAX_TOON_CHARS) + "\n# truncated";
      }

      const textBlock: TextContent = {
        type: "text",
        text: TOON_SENTINEL + toonEncoded,
      };

      return {
        ...result,
        content: [textBlock],
      };
    }

    return result;
  };

  return { ...tool, execute: wrappedExecute };
}

/**
 * Wraps an array of tools to apply TOON encoding to all of them.
 */
export function wrapToolsWithToonEncoding(tools: AnyAgentTool[]): AnyAgentTool[] {
  return tools.map(wrapToolWithToonEncoding);
}
