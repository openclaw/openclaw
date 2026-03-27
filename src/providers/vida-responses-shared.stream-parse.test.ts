/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from "vitest";
import { processResponsesStream } from "./vida-responses-shared.js";

async function* makeStream(events: any[]) {
  for (const event of events) {
    yield event;
  }
}

describe("vida-responses shared stream parser", () => {
  it("does not throw when function_call arguments contain malformed JSON", async () => {
    const output: any = {
      content: [],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
    };
    const stream: any[] = [];
    const model = {
      id: "agent-model",
      provider: "vida-1881960",
      api: "vida-responses",
      input: ["text"],
    };
    const malformedArgs = '{"command":"node -e "const now=1;""}';
    const events = [
      {
        type: "response.output_item.added",
        item: {
          type: "function_call",
          id: "fc_bad_args",
          call_id: "call_bad_args",
          name: "exec",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        delta: malformedArgs,
      },
      {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          id: "fc_bad_args",
          call_id: "call_bad_args",
          name: "exec",
          arguments: malformedArgs,
        },
      },
    ];

    await expect(
      processResponsesStream(makeStream(events), output, stream, model),
    ).resolves.toBeUndefined();

    const toolEnd = stream.find((evt) => evt?.type === "toolcall_end");
    expect(toolEnd).toBeTruthy();
    expect(toolEnd.toolCall?.name).toBe("exec");
    expect(toolEnd.toolCall?.arguments).toBeTruthy();
    expect(typeof toolEnd.toolCall.arguments).toBe("object");
  });
});
