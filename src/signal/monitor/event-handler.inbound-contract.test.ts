import { describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { buildDispatchInboundCaptureMock } from "../../../test/helpers/dispatch-inbound-capture.js";
import { expectInboundContextContract } from "../../../test/helpers/inbound-contract.js";

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
    // Sender should appear as prefix in group messages (no redundant [from:] suffix)
    expect(String(capturedCtx?.Body ?? "")).toContain("Alice");
    expect(String(capturedCtx?.Body ?? "")).toMatch(/Alice.*:/);
    expect(String(capturedCtx?.Body ?? "")).not.toContain("[from:");
  });
});
