import type { ServerResponse } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { writeOpenAiResponsesSse } from "./openai-responses-sse.js";

/** Fixed provider fixture output; execution and authority decisions stay with the real caller. */
export function writeOpenAiResponsesItem(
  response: ServerResponse,
  id: string,
  item: Record<string, unknown>,
  usage: Record<string, unknown> = { input_tokens: 32, output_tokens: 16, total_tokens: 48 },
) {
  writeOpenAiResponsesSse(response, [
    { type: "response.created", response: { id } },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { id, status: "completed", output: [item], usage } },
  ]);
}

export function readLatestUserMarker<T extends string>(
  body: Record<string, unknown>,
  markers: readonly (readonly [T, string])[],
): T | undefined {
  for (const item of (Array.isArray(body.input) ? body.input : []).toReversed()) {
    if (isRecord(item) && item.role === "user") {
      const text = JSON.stringify(item);
      const match = markers.find(([, marker]) => text.includes(marker));
      if (match) {
        return match[0];
      }
    }
  }
  return undefined;
}
