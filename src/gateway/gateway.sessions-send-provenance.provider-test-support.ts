import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { writeOpenAiResponsesSse } from "../../test/helpers/openai-responses-sse.js";
import { stripInternalRuntimeContext } from "../agents/internal-runtime-context.js";

export function respond(
  response: ServerResponse,
  tool?: { name: string; args: unknown },
  text = "NO_REPLY",
) {
  const id = randomUUID();
  const item = tool
    ? {
        type: "function_call",
        id: `fc_${id}`,
        call_id: `call_${id}`,
        name: tool.name,
        arguments: JSON.stringify(tool.args),
        status: "completed",
      }
    : {
        type: "message",
        id: `msg_${id}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: tool ? { ...item, status: "in_progress", arguments: "" } : item,
    },
    ...(tool
      ? [
          {
            type: "response.function_call_arguments.done",
            item_id: item.id,
            output_index: 0,
            arguments: JSON.stringify(tool.args),
          },
        ]
      : []),
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${id}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      },
    },
  ]);
}

export function toolOutput(body: Record<string, unknown>): unknown {
  const inputs = Array.isArray(body.input) ? body.input : [];
  const result = inputs.findLast((item) => isRecord(item) && item.type === "function_call_output");
  return isRecord(result) ? result.output : undefined;
}

export function toolResult(body: Record<string, unknown>): Record<string, unknown> | undefined {
  const output = toolOutput(body);
  const parsed: unknown = typeof output === "string" ? JSON.parse(output) : output;
  return isRecord(parsed) ? parsed : undefined;
}

export function lastUserText(body: Record<string, unknown>): string {
  const input = Array.isArray(body.input) ? body.input : [];
  for (let index = input.length - 1; index >= 0; index -= 1) {
    const item = input[index];
    if (!isRecord(item) || item.role !== "user") {
      continue;
    }
    const content =
      typeof item.content === "string"
        ? item.content
        : (Array.isArray(item.content) ? item.content : [])
            .flatMap((block) =>
              isRecord(block) && block.type === "input_text" && typeof block.text === "string"
                ? [block.text]
                : [],
            )
            .join("\n");
    // Runtime carriers can quote child tasks after the actual source input.
    const text = stripInternalRuntimeContext(content);
    if (
      /PROVENANCE_(?:SOURCE|TARGET|INCUMBENT|BOOTSTRAP)_|Agent-to-agent (?:announce|reply) step[.:]/.test(
        text,
      )
    ) {
      return text;
    }
  }
  return "";
}
