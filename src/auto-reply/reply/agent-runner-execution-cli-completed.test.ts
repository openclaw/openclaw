import { assert, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GetReplyOptions } from "../types.js";
import { setupCliExecutionTest } from "./agent-runner-execution-cli.test-support.js";

const {
  state,
  execute: executeCliTurn,
  mockEvents: mockCliEvents,
} = await setupCliExecutionTest("claude-opus-4-6");
beforeEach(async () => {
  const { createBlockReplyDeliveryHandler } =
    await vi.importActual<typeof import("./reply-delivery.js")>("./reply-delivery.js");
  state.createBlockReplyDeliveryHandlerMock.mockImplementationOnce(createBlockReplyDeliveryHandler);
});

it("delivers a completed reply with previews and block streaming off", async () => {
  const { setBlockReplyDelivery } = await import("./block-reply-delivery.js");
  const { onAgentEvent } = await import("../../infra/agent-events.js");
  const snapshots: unknown[] = [];
  const run = mockCliEvents(
    [
      ["assistant", { text: "First answer.", delta: "First answer." }],
      ["assistant", { completedText: "First answer.", assistantMessageIndex: 0 }],
    ],
    [{ text: "First answer." }, { text: "Final answer." }],
    { finalAssistantVisibleText: "First answer.\nFinal answer." },
  );
  onTestFinished(
    onAgentEvent((event) => {
      if (event.runId === run.id && event.stream === "assistant" && event.data.text) {
        snapshots.push(event.data.text);
      }
    }),
  );
  const onBlockReply = vi.fn<NonNullable<GetReplyOptions["onBlockReply"]>>(async () => {
    setBlockReplyDelivery(Promise.resolve({ outcome: "delivered" }));
  });
  const result = await executeCliTurn({ onBlockReply });
  expect(snapshots).toEqual(["First answer.", "First answer.\nFinal answer."]);
  expect(onBlockReply).toHaveBeenCalledOnce();
  expect(onBlockReply.mock.calls[0]?.[0]).toMatchObject({ text: "First answer." });
  assert(result.kind === "success");
  expect(result.directBlockDeliveries).toEqual([expect.objectContaining({ outcome: "delivered" })]);
  expect(result.runResult.payloads).toEqual([{ text: "First answer." }, { text: "Final answer." }]);
});

it.each([false, true])(
  "waits for prior commentary before completed delivery (start-order=%s)",
  async (preserveProgressCallbackStartOrder) => {
    mockCliEvents(
      [
        ["item", { kind: "preamble", itemId: "prior-commentary", progressText: "Checking." }],
        ["assistant", { completedText: "Done.", assistantMessageIndex: 0 }],
      ],
      [{ text: "Done." }],
    );
    const started = createDeferred();
    const release = createDeferred();
    const order: string[] = [];
    const onBlockReply: NonNullable<GetReplyOptions["onBlockReply"]> = async (payload) => {
      order.push(payload.text ?? "");
      if (payload.isCommentary) {
        started.resolve();
        await release.promise;
        order.push("commentary delivered");
      }
    };
    const run = executeCliTurn({
      onBlockReply,
      commentaryPayloadsEnabled: true,
      preserveProgressCallbackStartOrder,
    });
    try {
      await Promise.race([
        started.promise,
        run.then(() => {
          throw new Error("CLI completed before commentary started");
        }),
      ]);
      await Promise.resolve();
      expect(order).toEqual(["Checking."]);
    } finally {
      release.resolve();
      await Promise.allSettled([run]);
    }
    expect(order).toEqual(["Checking.", "commentary delivered", "Done."]);
  },
);
