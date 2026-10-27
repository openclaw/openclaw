import { createServer, type ServerResponse } from "node:http";
import { buffer } from "node:stream/consumers";
import { expect } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import { writeOpenAiResponsesSse } from "../../../test/helpers/openai-responses-sse.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";

export const sourceReplyFixture = {
  key: "agent:main:dashboard:source-reply-product-proof",
  prompt: "Send the requested checklist reply to this conversation.",
  delivered: "Explicit delivered reply: the synthetic checklist is ready.",
  commentary: "Checking the synthetic checklist before sending the reply.",
  acknowledgment: "Acknowledged. The requested reply was delivered.",
};

type InputItem = { type?: string; name?: string; call_id?: string; output?: string };
function messageItem(text: string, phase: string) {
  return {
    type: "message",
    id: phase + "-fixture",
    role: "assistant",
    phase,
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}
function textEvents(item: ReturnType<typeof messageItem>) {
  return [
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: item.content[0]!.text,
    },
    {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: item.content[0]!.text,
    },
    { type: "response.output_item.done", output_index: 0, item },
  ];
}
function complete(output: unknown[]) {
  return {
    type: "response.completed",
    response: {
      id: "synthetic-response",
      status: "completed",
      output,
      usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
    },
  };
}

/** Only inference is scripted: the real Gateway executes message.send and persists/publishes it. */
export async function startSourceReplyProvider(final: false | undefined) {
  const failures: unknown[] = [];
  const handlers = new Set<Promise<void>>();
  const toolArguments = {
    action: "send",
    message: sourceReplyFixture.delivered,
    ...(final === false ? { final } : {}),
  };
  let requests = 0;
  let receipt: string | undefined;
  let pending: ServerResponse | undefined;
  const reserved = await reserveTestPortListener({
    offsets: [0],
    createListener: () =>
      createServer((request, response) => {
        const handler = (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            request.resume();
            response.writeHead(404).end();
            return;
          }
          const body: { tools?: Array<{ name?: string }>; input?: InputItem[] } = JSON.parse(
            (await buffer(request)).toString("utf8"),
          );
          const step = requests++;
          if (step === 0) {
            expect(JSON.stringify(body.input)).toContain(sourceReplyFixture.prompt);
            expect(body.tools).toContainEqual(expect.objectContaining({ name: "message" }));
            const commentary = messageItem(sourceReplyFixture.commentary, "commentary");
            const call = {
              type: "function_call",
              id: "fc_source_reply",
              call_id: "call_source_reply",
              name: "message",
              arguments: JSON.stringify(toolArguments),
              status: "completed",
            };
            writeOpenAiResponsesSse(response, [
              ...textEvents(commentary),
              {
                type: "response.output_item.added",
                output_index: 1,
                item: { ...call, arguments: "", status: "in_progress" },
              },
              {
                type: "response.function_call_arguments.done",
                item_id: call.id,
                output_index: 1,
                arguments: call.arguments,
              },
              { type: "response.output_item.done", output_index: 1, item: call },
              complete([commentary, call]),
            ]);
          } else {
            expect(final, "only an explicit nonterminal send can continue inference").toBe(false);
            expect(step, "one actual tool execution, then one backing acknowledgment").toBe(1);
            const call = body.input?.findLast(
              (item) => item.type === "function_call" && item.name === "message",
            );
            expect(call?.call_id).toBeTruthy();
            receipt = body.input?.findLast(
              (item) => item.type === "function_call_output" && item.call_id === call?.call_id,
            )?.output;
            expect(receipt).toBeTruthy();
            expect(receipt).toContain("Sent visible reply");
            pending = response; // The browser observes real tool publication before backing completion.
          }
        })();
        handlers.add(handler);
        void handler.then(
          () => handlers.delete(handler),
          (error: unknown) => {
            handlers.delete(handler);
            failures.push(error);
            response.destroy();
          },
        );
      }),
  });
  return {
    port: reserved.claim.port,
    failures,
    requests: () => requests,
    toolArguments,
    receivedToolResult: () => receipt !== undefined,
    finish() {
      if (!pending || pending.destroyed) {
        throw new Error("Backing inference is not awaiting acknowledgment");
      }
      const answer = messageItem(sourceReplyFixture.acknowledgment, "final_answer");
      writeOpenAiResponsesSse(pending, [...textEvents(answer), complete([answer])]);
    },
    async close() {
      await runQaGatewayFixture(
        async () => {
          reserved.listener.closeAllConnections();
          await reserved.releaseListener();
          await Promise.all(handlers);
        },
        () => reserved.claim.release(),
      );
    },
  };
}
