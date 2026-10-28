import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as sqliteQueries from "../../infra/kysely-sync.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { INGRESS_CLAIM_LEASE_MS } from "./ingress-claim-owner.js";
import {
  countChannelIngressQueueHealth,
  countFailedChannelIngressQueueEntries,
} from "./ingress-queue-health.js";
import { createChannelIngressQueue, type ChannelIngressQueue } from "./ingress-queue.js";
import { DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS } from "./ingress-retry-policy.js";

async function recordAttempts(
  queue: ChannelIngressQueue<{ privatePayload: string }>,
  name: string,
  count = DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  withError = true,
) {
  const id = `${name}-private-id`;
  for (let attempt = 0; attempt < count; attempt += 1) {
    const claim = await queue.claim(id, { ownerId: "private-owner" });
    if (!claim) {
      throw new Error(`Expected ${id} claim ${attempt + 1}`);
    }
    await queue.release(claim, {
      lastError: withError ? `${name}-private-error` : undefined,
      releasedAt: 1_000 + attempt,
    });
  }
}

describe("channel ingress queue health", () => {
  afterEach(() => vi.restoreAllMocks());

  it("leaves absent ingress state uncreated when reading health", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-ingress-health-absent-", applyEnv: false },
      async ({ stateDir }) => {
        expect(await countFailedChannelIngressQueueEntries(stateDir)).toEqual([]);
        expect(await countChannelIngressQueueHealth(stateDir)).toEqual({
          failed: [],
          pressure: [],
        });
        expect(await fs.readdir(stateDir)).toEqual([]);
      },
    );
  });

  it("reports durable pressured lanes without leaking private or null-lane rows", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-ingress-health-", applyEnv: false },
      async ({ stateDir }) => {
        const now = 10 * INGRESS_CLAIM_LEASE_MS;
        vi.spyOn(Date, "now").mockReturnValue(now);
        let clock = now;
        const queue = createChannelIngressQueue<{ privatePayload: string }>({
          channelId: "telegram",
          accountId: "ops",
          stateDir,
          now: () => clock,
        });

        const enqueue = (name: string, receivedAt: number, lane: string | null = name) =>
          queue.enqueue(
            `${name}-private-id`,
            { privatePayload: `${name}-private-payload` },
            { laneKey: lane === null ? undefined : `${lane}-private-lane`, receivedAt },
          );
        const claim = async (name: string) => {
          const result = await queue.claim(`${name}-private-id`, {
            ownerId: `${name}-private-owner`,
          });
          if (!result) {
            throw new Error(`Expected ${name} claim`);
          }
        };
        await enqueue("retry", 100);
        await recordAttempts(queue, "retry");
        await enqueue("retry-follower", 200, "retry");
        await enqueue("ordinary", 300);
        await recordAttempts(queue, "ordinary", 1);
        await enqueue("no-error", 400);
        await recordAttempts(queue, "no-error", undefined, false);

        clock = now - INGRESS_CLAIM_LEASE_MS;
        await enqueue("stale", 500);
        await claim("stale");
        clock = now;
        await enqueue("stale-follower", 600, "stale");
        await enqueue("fresh", 700);
        await claim("fresh");
        await enqueue("null-pressured", 800, null);
        await recordAttempts(queue, "null-pressured");
        await enqueue("null-unrelated", 900, null);
        clock = now - INGRESS_CLAIM_LEASE_MS;
        await enqueue("null-stale", 1_000, null);
        await claim("null-stale");
        clock = now;

        const hostQueries = vi
          .spyOn(sqliteQueries, "executeSqliteQuerySync")
          .mockImplementation(() => {
            throw new Error("Ingress health must not query SQLite on the calling thread");
          });
        try {
          const { failed, pressure } = await countChannelIngressQueueHealth(stateDir);
          expect(failed).toEqual([]);
          expect(pressure).toEqual([
            {
              channelId: "telegram",
              accountId: "ops",
              laneCount: 2,
              pendingCount: 3,
              claimedCount: 1,
              blockedCount: 2,
              oldestReceivedAt: 100,
            },
          ]);
          expect(JSON.stringify(pressure)).not.toMatch(
            /private-(?:id|lane|owner|payload|error)|retry-private|stale-private|null-(?:pressured|stale)/,
          );
          expect(hostQueries).not.toHaveBeenCalled();
        } finally {
          hostQueries.mockRestore();
        }
      },
    );
  });
});
