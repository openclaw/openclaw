import type { ServerResponse } from "node:http";
import { writeOpenAiResponsesSse } from "../../../helpers/openai-responses-sse.js";

export function writeToolResponse(
  response: ServerResponse,
  item: { id: string; call_id: string; name: string; arguments: string },
  responseId: string,
  tokens = { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  argumentsDone = false,
) {
  const call = { type: "function_call", ...item };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: item.id,
      output_index: 0,
      delta: item.arguments,
    },
    ...(argumentsDone
      ? [
          {
            type: "response.function_call_arguments.done",
            item_id: item.id,
            output_index: 0,
            name: item.name,
            arguments: item.arguments,
          },
        ]
      : []),
    { type: "response.output_item.done", output_index: 0, item: call },
    {
      type: "response.completed",
      response: { id: responseId, status: "completed", output: [call], usage: tokens },
    },
  ]);
}
