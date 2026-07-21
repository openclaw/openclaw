import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  OutboundDeliveryError,
  PartialReplyDeliveryError,
} from "../infra/outbound/deliver-types.js";
import {
  markNativeDeliveryNotAttempted,
  markSuccessfulNativeDelivery,
} from "../infra/outbound/message-sent-hook.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.types.js";
import { buildTestCtx } from "./reply/test-ctx.js";

const hoisted = vi.hoisted(() => ({
  getGlobalHookRunner: vi.fn(),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: hoisted.getGlobalHookRunner,
}));

const { installOutboundHookAfterDeliver } = await import("./outbound-hook-lifecycle.js");

function captureAfterDeliver(runMessageSent: ReturnType<typeof vi.fn>) {
  let afterDeliver: Parameters<NonNullable<ReplyDispatcher["appendAfterDeliver"]>>[0] | undefined;
  const dispatcher = {
    appendAfterDeliver: vi.fn((hook) => {
      afterDeliver = hook;
    }),
  } as unknown as ReplyDispatcher;
  hoisted.getGlobalHookRunner.mockReturnValue({
    hasHooks: vi.fn((hookName?: string) => hookName === "message_sent"),
    runMessageSent,
  });
  installOutboundHookAfterDeliver(
    dispatcher,
    buildTestCtx({ Surface: "feishu", SessionKey: "agent:test:session" }),
    { runId: "run-partial" },
  );
  if (!afterDeliver) {
    throw new Error("expected after-delivery hook");
  }
  return afterDeliver;
}

describe("outbound hook after-delivery failures", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits the provider-finalized visible receipt for a partial reply failure", async () => {
    const runMessageSent = vi.fn(async (_event: unknown, _ctx: unknown) => undefined);
    const afterDeliver = captureAfterDeliver(runMessageSent);
    const error = markSuccessfulNativeDelivery(
      new PartialReplyDeliveryError("media upload failed", {
        cause: new Error("provider 504"),
        deliveryResult: {
          visibleReplySent: true,
          messageId: "message-1",
          content: "provider-finalized text",
        },
      }),
      "bookkeeping-marker-must-not-win",
    );

    await afterDeliver({ text: "requested text" }, { kind: "final" }, { status: "failed", error });

    expect(runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "provider-finalized text",
        error: "media upload failed | provider 504",
        messageId: "message-1",
        runId: "run-partial",
        success: false,
      }),
      expect.anything(),
    );
  });

  it("uses durable outbound partial results for caller-owned failure observation", async () => {
    const runMessageSent = vi.fn(async (_event: unknown, _ctx: unknown) => undefined);
    const afterDeliver = captureAfterDeliver(runMessageSent);
    const error = new OutboundDeliveryError("second media failed", {
      cause: new Error("provider 500"),
      results: [{ channel: "telegram", messageId: "42" }],
      stage: "platform_send",
    });

    await afterDeliver({ text: "visible caption" }, { kind: "final" }, { status: "failed", error });

    expect(runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "visible caption",
        error: "second media failed | provider 500",
        messageId: "42",
        runId: "run-partial",
        success: false,
      }),
      expect.anything(),
    );
  });

  it("reports native success when only durable queue cleanup fails", async () => {
    const runMessageSent = vi.fn(async (_event: unknown, _ctx: unknown) => undefined);
    const afterDeliver = captureAfterDeliver(runMessageSent);
    const error = markSuccessfulNativeDelivery(
      new OutboundDeliveryError("queue ack failed", {
        cause: new Error("state unavailable"),
        results: [{ channel: "telegram", messageId: "message-1" }],
        stage: "queue",
      }),
      "message-1",
    );

    await afterDeliver({ text: "delivered text" }, { kind: "final" }, { status: "failed", error });

    expect(runMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "delivered text",
        messageId: "message-1",
        runId: "run-partial",
        success: true,
      }),
      expect.anything(),
    );
    expect(runMessageSent.mock.calls[0]?.[0]).not.toHaveProperty("error");
  });

  it("does not report message_sent when delivery fails before the provider attempt", async () => {
    const runMessageSent = vi.fn(async (_event: unknown, _ctx: unknown) => undefined);
    const afterDeliver = captureAfterDeliver(runMessageSent);
    const error = markNativeDeliveryNotAttempted("queue staging failed");

    await afterDeliver({ text: "not delivered" }, { kind: "final" }, { status: "failed", error });

    expect(error).toEqual(expect.objectContaining({ message: "queue staging failed" }));
    expect(runMessageSent).not.toHaveBeenCalled();
  });
});
