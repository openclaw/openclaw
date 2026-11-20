import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { respondToActivityRecap } from "./cron-human-owner-provider.test-support.ts";

function recapRequest() {
  return {
    model: "edited",
    input: [
      {
        type: "message",
        role: "system",
        content: [
          {
            type: "input_text",
            text: "Write an Activity recap for someone scanning their tasks: what was done here, and where it stands now. Return plain recap text only.",
          },
        ],
      },
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify({ previousRecap: "", messages: [], omittedContent: false }),
          },
        ],
      },
    ],
  };
}

function responseSink() {
  const response = { writeHead: vi.fn(), end: vi.fn() };
  return { response: response as unknown as ServerResponse, ...response };
}

describe("human-owner fixture activity recap", () => {
  it("serves the recap separately while retaining exactly two primary requests", () => {
    const sink = responseSink();
    const primary = { model: "edited", input: [] };
    const models = [primary, recapRequest(), primary]
      .filter((request) => !respondToActivityRecap(sink.response, request))
      .map((request) => request.model);
    expect(models).toEqual(["edited", "edited"]);
    expect(sink.writeHead).toHaveBeenCalledExactlyOnceWith(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    expect(sink.end).toHaveBeenCalledTimes(1);
    const stream = sink.end.mock.calls[0]![0] as string;
    expect(stream).toContain('"id":"activity-recap-response","status":"completed"');
    expect(stream).toContain("The automation wrote its execution witness and completed.");
    expect(stream).toMatch(/data: \[DONE\]\n\n$/u);
  });

  it.each([
    [
      "same-model primary",
      (request: ReturnType<typeof recapRequest>) => {
        request.input[0]!.content[0]!.text = "Perform the automation.";
      },
    ],
    [
      "recap mentioned only by user",
      (request: ReturnType<typeof recapRequest>) => {
        request.input.reverse();
      },
    ],
    [
      "malformed envelope",
      (request: ReturnType<typeof recapRequest>) => {
        request.input[1]!.content[0]!.text = "not JSON";
      },
    ],
    [
      "foreign envelope",
      (request: ReturnType<typeof recapRequest>) => {
        request.input[1]!.content[0]!.text = '{"conversationLabelSource":"task"}';
      },
    ],
    [
      "extra envelope field",
      (request: ReturnType<typeof recapRequest>) => {
        request.input[1]!.content[0]!.text =
          '{"previousRecap":"","messages":[],"omittedContent":false,"extra":true}';
      },
    ],
  ])("counts third unmatched request: %s", (_name, change) => {
    const sink = responseSink();
    const unmatched = recapRequest();
    change(unmatched);
    const primary = { model: "edited", input: [] };
    const models = [primary, primary, unmatched]
      .filter((request) => !respondToActivityRecap(sink.response, request))
      .map((request) => request.model);
    expect(models).toEqual(["edited", "edited", "edited"]);
    expect(models).not.toHaveLength(2);
    expect(sink.writeHead).not.toHaveBeenCalled();
    expect(sink.end).not.toHaveBeenCalled();
  });

  it("does not consume a tool-bearing primary request with recap-shaped input", () => {
    const sink = responseSink();
    expect(
      respondToActivityRecap(sink.response, {
        ...recapRequest(),
        tools: [{ type: "function", name: "write" }],
      }),
    ).toBe(false);
    expect(sink.end).not.toHaveBeenCalled();
  });
});
