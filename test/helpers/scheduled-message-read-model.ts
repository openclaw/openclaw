import type { IncomingMessage, ServerResponse } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect } from "vitest";
import { writeOpenAiResponsesSse, writeOpenAiResponsesText } from "./openai-responses-sse.js";

type ModelObservation = {
  requests: number;
  messageToolAdvertised: boolean;
  toolOutput?: string;
};

// Only model decisions are synthetic; the runner must supply the real tool schema
// and return the provider result before this endpoint emits the final response.
export function createScheduledMessageReadModel(params: {
  modelId: string;
  apiKey: string;
  actionParams: Record<string, unknown>;
  assertToolResult: (text: string) => void;
  assertToolSchema?: (schema: unknown) => void;
}) {
  const observation: ModelObservation = { requests: 0, messageToolAdvertised: false };
  return {
    observation,
    async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
      const authorizationMatches = request.headers.authorization === `Bearer ${params.apiKey}`;
      expect(authorizationMatches, "synthetic model authorization matches").toBe(true);
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!isRecord(body)) {
        throw new Error("Expected a Responses request object");
      }
      expect(body).toMatchObject({ model: params.modelId, stream: true });
      observation.requests++;
      if (observation.requests === 1) {
        const tools = Array.isArray(body.tools) ? body.tools.filter(isRecord) : [];
        expect(tools).toContainEqual(
          expect.objectContaining({ type: "function", name: "message" }),
        );
        params.assertToolSchema?.(tools.find((tool) => tool.name === "message")?.parameters);
        observation.messageToolAdvertised = true;
        const item = {
          type: "function_call",
          id: "fc_scheduled_message",
          call_id: "call_scheduled_message",
          name: "message",
          arguments: JSON.stringify(params.actionParams),
          status: "completed",
        };
        writeOpenAiResponsesSse(response, [
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...item, status: "in_progress", arguments: "" },
          },
          {
            type: "response.function_call_arguments.delta",
            item_id: item.id,
            output_index: 0,
            delta: item.arguments,
          },
          {
            type: "response.function_call_arguments.done",
            item_id: item.id,
            output_index: 0,
            arguments: item.arguments,
          },
          { type: "response.output_item.done", output_index: 0, item },
          {
            type: "response.completed",
            response: {
              id: "resp_scheduled_message_call",
              status: "completed",
              output: [item],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          },
        ]);
        return;
      }
      expect(observation.requests, "one tool call and one final model response").toBe(2);
      const input = Array.isArray(body.input) ? body.input.filter(isRecord) : [];
      // Runtime normalization may change call IDs; follow the actual replayed pair.
      const call = input.find((item) => item.type === "function_call" && item.name === "message");
      if (typeof call?.call_id !== "string") {
        throw new Error("Expected the scheduled message call in the model continuation");
      }
      const output = input.find(
        (item) => item.type === "function_call_output" && item.call_id === call.call_id,
      );
      if (typeof output?.output !== "string") {
        throw new Error("Expected the scheduled message function_call_output");
      }
      params.assertToolResult(output.output);
      observation.toolOutput = output.output;
      writeOpenAiResponsesText(response, {
        text: output.output,
        messageId: "msg_scheduled_message_final",
        responseId: "resp_scheduled_message_final",
      });
    },
  };
}
