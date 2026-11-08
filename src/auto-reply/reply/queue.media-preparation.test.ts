import { expect, it } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { createQueueCase } from "./queue.case.test-support.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import type { InternalFollowupRun } from "./queue/types.js";

it.for([false, true])(
  "keeps prepared and unprepared media in separate queue batches (overflow=%s)",
  async (overflow, { signal }) => {
    const q = createQueueCase(overflow ? { cap: 1 } : {});
    const raw: InternalFollowupRun = {
      ...createQueueTestRun({ prompt: "raw attachment" }),
      media: [{ path: "/tmp/raw.png", contentType: "image/png" }],
    };
    const prepared: InternalFollowupRun = {
      ...createQueueTestRun({ prompt: "materialized attachment" }),
      currentTurnImagesPrepared: true,
      images: [],
      imageOrder: ["offloaded"],
      media: [{ path: "/tmp/prepared.png", contentType: "image/png" }],
      mediaImageLayout: { slots: [{ kind: "offloaded", factIndex: 0 }] },
    };
    try {
      q.add(raw);
      q.add(prepared);
      if (overflow) {
        q.add(createQueueTestRun({ prompt: "surviving text" }));
      }
      const receipts = getExistingFollowupQueue(q.key)!.entries.map(
        (input) => input.settlement.promise,
      );
      q.start();
      await withinTest(Promise.all(receipts), signal);

      expect(q.calls).toHaveLength(overflow ? 3 : 2);
      const rawDelivery: InternalFollowupRun | undefined = q.calls[0];
      const preparedDelivery: InternalFollowupRun | undefined = q.calls[1];
      expect(rawDelivery?.prompt).toContain("raw attachment");
      expect(rawDelivery?.prompt).not.toContain("materialized attachment");
      expect(rawDelivery?.currentTurnImagesPrepared).toBeUndefined();
      expect(rawDelivery?.images).toBeUndefined();
      expect(rawDelivery?.imageOrder).toBeUndefined();
      expect(rawDelivery?.mediaImageLayout).toBeUndefined();
      expect(rawDelivery?.media).toEqual(raw.media);
      expect(preparedDelivery?.prompt).toContain("materialized attachment");
      expect(preparedDelivery?.prompt).not.toContain("raw attachment");
      expect(preparedDelivery?.currentTurnImagesPrepared).toBe(true);
      expect(preparedDelivery?.images).toEqual([]);
      expect(preparedDelivery?.imageOrder).toEqual(["offloaded"]);
      expect(preparedDelivery?.media).toEqual(prepared.media);
      expect(preparedDelivery?.mediaImageLayout).toMatchObject({
        slots: [{ kind: "offloaded", factIndex: 0 }],
      });
      if (overflow) {
        expect(rawDelivery?.prompt).toContain("[Queue overflow]");
        expect(preparedDelivery?.prompt).toContain("[Queue overflow]");
        expect(q.calls[2]?.prompt).toBe("surviving text");
      }
    } finally {
      clearFollowupQueue(q.key);
    }
  },
);
