import { describe, expect, it, vi } from "vitest";
import { INGRESS_CLAIM_LEASE_MS } from "../../channels/message/ingress-claim-owner.js";
import { countChannelIngressQueueHealth } from "../../channels/message/ingress-queue-health.js";
import { createChannelIngressQueue } from "../../channels/message/ingress-queue.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL channel ingress health", () => {
  const state = useMixedAgentPair("postgres", "sqlite");

  it("reports numeric counts for a blocked lane", async () => {
    const database = withEngineStoreAdmission(() => openOpenClawStateDatabase());
    expect(isPostgresSqlConnection(database.db)).toBe(true);
    const claimedAt = 10 * INGRESS_CLAIM_LEASE_MS;
    const queue = createChannelIngressQueue({
      channelId: "telegram",
      accountId: "default",
      stateDir: state.root,
      now: () => claimedAt,
    });
    await queue.enqueue("head", {}, { laneKey: "lane", receivedAt: claimedAt - 2 });
    expect(await queue.claim("head", { ownerId: "worker" })).toBeTruthy();
    await queue.enqueue("follower", {}, { laneKey: "lane", receivedAt: claimedAt - 1 });

    using _ = vi.spyOn(Date, "now").mockReturnValue(claimedAt + INGRESS_CLAIM_LEASE_MS);
    const { pressure } = await countChannelIngressQueueHealth(state.root);
    expect(pressure).toEqual([
      {
        channelId: "telegram",
        accountId: "default",
        laneCount: 1,
        pendingCount: 1,
        claimedCount: 1,
        blockedCount: 1,
        oldestReceivedAt: claimedAt - 2,
      },
    ]);
  });
});
