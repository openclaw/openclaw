// Gateway draining hold: keep the claim until the backoff elapses.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GatewayDrainingError } from "../../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

describe("channel ingress drain draining hold", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    closeOpenClawStateDatabaseForTest();
  });

  it("holds a GatewayDrainingError claim before release so the next pump cannot re-claim instantly", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir);
      await queue.enqueue("evt-draining", { text: "x" }, { laneKey: "l1" });
      const dispatches: string[] = [];
      const drain = createChannelIngressDrain<Payload>({
        queue,
        dispatchClaimedEvent: async (event) => {
          dispatches.push(event.id);
          throw new GatewayDrainingError();
        },
      });

      const idle = drain.waitForIdle();
      await drain.drainOnce();
      await vi.advanceTimersByTimeAsync(0);

      expect(dispatches).toEqual(["evt-draining"]);
      expect(await queue.listClaims()).toEqual([
        expect.objectContaining({ id: "evt-draining", attempts: 0 }),
      ]);
      expect(await queue.listPending()).toEqual([]);
      // Still claimed, so the next pump iteration cannot spin the same row.
      expect(await drain.drainOnce()).toEqual({ started: 0 });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(await queue.listClaims()).toHaveLength(1);
      expect(await drain.drainOnce()).toEqual({ started: 0 });

      await vi.advanceTimersByTimeAsync(1);
      await idle;
      expect(await queue.listClaims()).toEqual([]);
      expect(await queue.listPending()).toEqual([
        expect.objectContaining({ id: "evt-draining", attempts: 0 }),
      ]);
      expect(await queue.listFailed?.()).toEqual([]);
      drain.dispose();
    });
  });
});
