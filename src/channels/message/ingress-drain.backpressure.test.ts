// Durable ingress backpressure tests cover exact-payload restart replay.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
  settleChannelIngressBackpressure,
} from "./ingress-drain.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

type Payload = { text: string };
type Metadata = { source: string };
type ChannelIngressDispatchLifecycle = Parameters<
  Parameters<typeof createChannelIngressDrain>[0]["dispatchClaimedEvent"]
>[1];

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ingress-backpressure-"));
  try {
    return await fn(stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("channel ingress backpressure", () => {
  it("waits for every fanout child and abandons failed or legacy participants", async () => {
    let releaseSlowCleanup: () => void = () => {};
    const slowCleanup = new Promise<void>((resolve) => {
      releaseSlowCleanup = resolve;
    });
    const events: string[] = [];
    let settled = false;

    const cleanup = settleChannelIngressBackpressure(
      [
        {
          onBackpressured: async () => {
            events.push("rejecting:backpressure");
            throw new Error("cleanup failed");
          },
          onAbandoned: async () => {
            events.push("rejecting:abandoned");
          },
        },
        {
          onBackpressured: async () => {
            events.push("slow:start");
            await slowCleanup;
            events.push("slow:end");
          },
        },
        {
          onAbandoned: async () => {
            events.push("legacy:abandoned");
          },
        },
      ],
      new Error("capacity"),
      "test ingress",
    ).then(() => {
      settled = true;
    });

    await vi.waitFor(() =>
      expect(events).toEqual([
        "rejecting:backpressure",
        "slow:start",
        "legacy:abandoned",
        "rejecting:abandoned",
      ]),
    );
    expect(settled).toBe(false);

    releaseSlowCleanup();
    await cleanup;
    expect(events).toContain("slow:end");
    expect(settled).toBe(true);
  });

  it("replays the exact payload after restart without consuming retry budget", async () => {
    await withTempState(async (stateDir) => {
      let now = 1_000;
      const queue = createChannelIngressQueue<Payload, Metadata>({
        channelId: "test",
        accountId: "a",
        stateDir,
        now: () => now,
      });
      const payload = { text: "retry me" };
      const metadata = { source: "original-transport" };
      await queue.enqueue("evt-backpressure", payload, { laneKey: "lane-a", metadata });
      const backpressure = Object.assign(new Error("Follow-up queue capacity exhausted"), {
        [Symbol.for("openclaw.ingressRetryWithoutPenalty")]: true,
      });
      let deferredLifecycle:
        | ReturnType<typeof bindIngressLifecycleToReplyOptions>["turnAdoptionLifecycle"]
        | undefined;

      const firstDrain = createChannelIngressDrain<Payload, Metadata>({
        queue,
        now: () => now,
        dispatchClaimedEvent: async (_event, lifecycle) => {
          deferredLifecycle = bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle;
          return { kind: "deferred" };
        },
      });
      expect(await firstDrain.drainOnce()).toEqual({ started: 1 });
      await firstDrain.waitForIdle();
      expect(await queue.listClaims()).toHaveLength(1);

      await deferredLifecycle?.onBackpressured?.(backpressure);
      expect(await queue.listPending({ limit: "all" })).toMatchObject([
        {
          id: "evt-backpressure",
          attempts: 0,
          lastAttemptAt: now,
          lastError: "Follow-up queue capacity exhausted",
          payload,
          metadata,
          laneKey: "lane-a",
        },
      ]);
      firstDrain.dispose();

      const dispatch = vi.fn(
        async (_event: unknown, lifecycle: ChannelIngressDispatchLifecycle) => {
          await lifecycle.onAdopted();
        },
      );
      const restartedDrain = createChannelIngressDrain<Payload, Metadata>({
        queue,
        now: () => now,
        dispatchClaimedEvent: dispatch,
      });

      expect(await restartedDrain.drainOnce()).toEqual({ started: 0 });
      expect(dispatch).not.toHaveBeenCalled();

      now += 1_000;
      expect(await restartedDrain.drainOnce()).toEqual({ started: 1 });
      await restartedDrain.waitForIdle();
      expect(dispatch).toHaveBeenCalledOnce();
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        id: "evt-backpressure",
        payload,
        metadata,
        laneKey: "lane-a",
      });
      expect(await queue.listPending({ limit: "all" })).toEqual([]);
      restartedDrain.dispose();
    });
  });
});
