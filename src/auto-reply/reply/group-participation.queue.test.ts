import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  createGroupReplyFixture,
  decision,
  judgment,
} from "./group-participation.reply.test-support.js";
import type { QueuedFollowupReplyBatch } from "./queue/types.js";

let fixture: Awaited<ReturnType<typeof createGroupReplyFixture>>;
beforeEach(async () => {
  fixture = await createGroupReplyFixture();
  decision.mockReset();
});
afterEach(async () => {
  await fixture.close();
});

it.each(["reply", "silent"] as const)(
  "assesses queued %s and settles its source",
  async (choice) => {
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
    const settlement = createDeferred();
    const batches: QueuedFollowupReplyBatch[] = [];
    const onAdopted = vi.fn();
    const onAbandoned = vi.fn();
    const first = fixture.reply("First question.", `first-${choice}`, "-10004", undefined, {
      WasMentioned: true,
    });
    try {
      await awaitGateBeforeSettlement(firstStarted.promise, first, "First model did not start");
      decision.mockResolvedValue(judgment(choice));
      const queued = await fixture.dispatch("Which port?", `queued-${choice}`, "-10004", {
        turnAdoptionLifecycle: { onAdopted, onAbandoned },
        onQueuedFollowupSettled: () => {
          settlement.resolve();
        },
        onQueuedFollowupReplyBatch: async (batch) => {
          batches.push(batch);
        },
      });
      expect(queued.deferredToActiveRun).toBe("followup");
      expect(decision).not.toHaveBeenCalled();
      releaseFirst.resolve();
      await first;
      if (choice === "reply") {
        await awaitGateBeforeSettlement(
          queuedStarted.promise,
          settlement.promise,
          "Queued model did not start",
        );
      }
      releaseQueued.resolve();
      await settlement.promise;
      expect(decision).toHaveBeenCalledOnce();
      expect(onAdopted).toHaveBeenCalledOnce();
      expect(onAbandoned).not.toHaveBeenCalled();
      expect(fixture.requests).toHaveLength(choice === "reply" ? 2 : 1);
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
      await settlement.promise;
    }
  },
);
