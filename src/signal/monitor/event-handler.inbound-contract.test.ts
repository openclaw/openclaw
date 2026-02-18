import { describe, expect, it, vi } from "vitest";
import { buildDispatchInboundContextCapture } from "../../../test/helpers/inbound-contract-capture.js";
import { expectInboundContextContract } from "../../../test/helpers/inbound-contract.js";
import type { MsgContext } from "../../auto-reply/templating.js";

const capture = vi.hoisted(() => ({ ctx: undefined as MsgContext | undefined }));

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  return await buildDispatchInboundContextCapture(importOriginal, capture);
});

import { createSignalEventHandler } from "./event-handler.js";
import {
  createBaseSignalEventHandlerDeps,
  createSignalReceiveEvent,
} from "./event-handler.test-harness.js";

describe("signal createSignalEventHandler inbound contract", () => {
  it("passes a finalized MsgContext to dispatchInboundMessage", async () => {
    capture.ctx = undefined;

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        // oxlint-disable-next-line typescript/no-explicit-any
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "hi",
          attachments: [],
          groupInfo: { groupId: "g1", groupName: "Test Group" },
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    expectInboundContextContract(capture.ctx!);
    const contextWithBody = capture.ctx as unknown as { Body?: string };
    // Sender should appear as prefix in group messages (no redundant [from:] suffix)
    expect(String(contextWithBody.Body ?? "")).toContain("Alice");
    expect(String(contextWithBody.Body ?? "")).toMatch(/Alice.*:/);
    expect(String(contextWithBody.Body ?? "")).not.toContain("[from:");
  });

  it("normalizes direct chat To/OriginatingTo targets to canonical Signal ids", async () => {
    capture.ctx = undefined;

    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        // oxlint-disable-next-line typescript/no-explicit-any
        cfg: { messages: { inbound: { debounceMs: 0 } } } as any,
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        sourceNumber: "+15550002222",
        sourceName: "Bob",
        timestamp: 1700000000001,
        dataMessage: {
          message: "hello",
          attachments: [],
        },
      }),
    );

    expect(capture.ctx).toBeTruthy();
    const context = capture.ctx as unknown as {
      ChatType?: string;
      To?: string;
      OriginatingTo?: string;
    };
    expect(context.ChatType).toBe("direct");
    expect(context.To).toBe("+15550002222");
    expect(context.OriginatingTo).toBe("+15550002222");
  });
});
