import { describe, expect, it, vi } from "vitest";
import { buildDispatchInboundCaptureMock } from "../../../test/helpers/dispatch-inbound-capture.js";
import { expectInboundContextContract } from "../../../test/helpers/inbound-contract.js";
import type { MsgContext } from "../../auto-reply/templating.js";

let capturedCtx: MsgContext | undefined;

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return buildDispatchInboundCaptureMock(actual, (ctx) => {
    capturedCtx = ctx as MsgContext;
  });
});

import { createSignalEventHandler } from "./event-handler.js";
import { createBaseSignalEventHandlerDeps } from "./event-handler.test-harness.js";

describe("signal createSignalEventHandler inbound contract", () => {
  it("passes a finalized MsgContext to dispatchInboundMessage", async () => {
    capturedCtx = undefined;

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        // oxlint-disable-next-line typescript/no-explicit-any
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        historyLimit: 0,
      }),
    );

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550001111",
          sourceName: "Alice",
          timestamp: 1700000000000,
          dataMessage: {
            message: "hi",
            attachments: [],
            groupInfo: { groupId: "g1", groupName: "Test Group" },
          },
        },
      }),
    });

    expect(capturedCtx).toBeTruthy();
    expectInboundContextContract(capturedCtx!);
    const contextWithBody = capturedCtx as unknown as { Body?: string };
    // Sender should appear as prefix in group messages (no redundant [from:] suffix)
    expect(String(contextWithBody.Body ?? "")).toContain("Alice");
    expect(String(contextWithBody.Body ?? "")).toMatch(/Alice.*:/);
    expect(String(contextWithBody.Body ?? "")).not.toContain("[from:");
  });

  it("normalizes direct chat To/OriginatingTo targets to canonical Signal ids", async () => {
    capturedCtx = undefined;

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        // oxlint-disable-next-line typescript/no-explicit-any
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        historyLimit: 0,
      }),
    );

    await handler({
      event: "receive",
      data: JSON.stringify({
        envelope: {
          sourceNumber: "+15550002222",
          sourceName: "Bob",
          timestamp: 1700000000001,
          dataMessage: {
            message: "hello",
            attachments: [],
          },
        },
      }),
    });

    expect(capturedCtx).toBeTruthy();
    const context = capturedCtx as unknown as {
      ChatType?: string;
      To?: string;
      OriginatingTo?: string;
    };
    expect(context.ChatType).toBe("direct");
    expect(context.To).toBe("+15550002222");
    expect(context.OriginatingTo).toBe("+15550002222");
  });
});
