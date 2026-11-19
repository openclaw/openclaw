import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  createGroupReplyFixture,
  decision,
  judgment,
} from "./group-participation.reply.test-support.js";
import type { QueuedFollowupReplyBatch } from "./queue/types.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
import type { TypingController } from "./typing.js";

let fixture: Awaited<ReturnType<typeof createGroupReplyFixture>>;
beforeEach(async () => {
  fixture = await createGroupReplyFixture();
  decision.mockReset();
});
afterEach(async () => {
  await fixture.close();
});

it.each(["reply", "silent"] as const)(
  "assesses queued %s before typing and settles its source",
  async (choice) => {
    fixture.config.agents!.defaults!.typingMode = "instant";
    const firstStarted = createDeferred();
    const releaseFirst = createDeferred();
    const queuedStarted = createDeferred();
    const releaseQueued = createDeferred();
    fixture.respond(
      {
        delta: { role: "assistant", content: "First reply." },
        beforeOutput: async () => {
          firstStarted.resolve();
          await releaseFirst.promise;
        },
      },
      {
        delta: { role: "assistant", content: "Queued reply." },
        beforeOutput: async () => {
          queuedStarted.resolve();
          await releaseQueued.promise;
        },
      },
    );
    const state: ReplyOperationRunState = {};
    const batches: QueuedFollowupReplyBatch[] = [];
    let typing: TypingController | undefined;
    const onAdopted = vi.fn();
    const onAbandoned = vi.fn();
    const first = fixture.reply("First question.", `first-${choice}`, "-10004", undefined, {
      WasMentioned: true,
    });
    try {
      await awaitGateBeforeSettlement(firstStarted.promise, first, "First model did not start");
      const before = fixture.typing();
      decision.mockImplementation(async () => {
        expect(fixture.typing()).toBe(before);
        return judgment(choice);
      });
      const queued = await fixture.dispatch("Which port?", `queued-${choice}`, "-10004", {
        turnAdoptionLifecycle: { onAdopted, onAbandoned },
        [REPLY_OPERATION_RUN_STATE]: state,
        onTypingController: (controller) => {
          typing = controller;
        },
        onQueuedFollowupReplyBatch: async (batch) => {
          batches.push(batch);
        },
      });
      expect(queued.deferredToActiveRun).toBe("followup");
      expect(decision).not.toHaveBeenCalled();
      expect(fixture.typing()).toBe(before);
      expect(fixture.stopped()).toBe(0);
      const settlement = state.followupSourceSettlement;
      if (!settlement) {
        throw new Error("The queued source has no settlement receipt");
      }
      releaseFirst.resolve();
      await first;
      if (choice === "reply") {
        await awaitGateBeforeSettlement(
          queuedStarted.promise,
          settlement,
          "Queued model did not start",
        );
        expect(typing?.isActive()).toBe(true);
        expect(fixture.typing()).toBeGreaterThan(before);
        expect(fixture.stopped()).toBe(0);
      }
      releaseQueued.resolve();
      await settlement;
      expect(decision).toHaveBeenCalledOnce();
      expect(onAdopted).toHaveBeenCalledOnce();
      expect(onAbandoned).not.toHaveBeenCalled();
      expect(fixture.requests).toHaveLength(choice === "reply" ? 2 : 1);
      expect(fixture.typing() > before).toBe(choice === "reply");
      expect(typing?.isActive()).toBe(false);
      expect(fixture.stopped()).toBe(1);
      expect(batches).toMatchObject([
        {
          payloads: choice === "reply" ? [{ text: "Queued reply." }] : [],
          completion: { kind: "completed" },
        },
      ]);
    } finally {
      releaseFirst.resolve();
      releaseQueued.resolve();
      await first;
      await state.followupSourceSettlement;
    }
  },
);
