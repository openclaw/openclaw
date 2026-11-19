import { expect, it } from "vitest";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { collectForRetentionCheck } from "../test-utils/retention.js";
import type { ControlUiSessionPrTarget } from "./control-ui-session-pr-read.js";
import { createControlUiSessionPullRequestSubscriptions } from "./control-ui-session-pr-subscriptions.js";

it("releases prepared PR identities when sessions retire and the owner stops", async () => {
  const scheduler = createTestGatewayScheduler();
  const owner = createControlUiSessionPullRequestSubscriptions({
    scheduler,
    prepareRead: async () => undefined,
    broadcastToConnIds: () => {},
  });
  const prepare = (start: number, count: number, retire: boolean) => {
    for (let index = start; index < start + count; index++) {
      // Flatten distinct source identities so the fixture cannot share a backing string.
      const bytes = Buffer.alloc(4096, 97 + (index % 26));
      bytes.write(`synthetic-repository-${index}:`);
      const target: ControlUiSessionPrTarget = {
        params: { agentId: "main", sessionKey: `agent:main:retention-${index}` },
        identity: bytes.toString("ascii"),
        readSource: { agentId: "main", path: "/synthetic/agent.sqlite" },
        source: null,
      };
      if (owner.readPrepared(target)?.status !== "ready") {
        throw new Error("Expected a prepared empty PR snapshot");
      }
      if (retire) {
        sessionChanges.emit({ ...target.params, facts: { kind: "removed" } });
      }
    }
  };
  try {
    prepare(0, 256, true);
    await collectForRetentionCheck("prepared-pr-warm");
    const before = process.memoryUsage().heapUsed;
    prepare(256, 5000, true);
    await collectForRetentionCheck("prepared-pr-retired");
    // The broken index keeps >20 MiB after all source sessions have retired.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(8 * 1024 ** 2);
    prepare(5256, 5000, false);
    await owner.stop();
    await collectForRetentionCheck("prepared-pr-stopped");
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(8 * 1024 ** 2);
    expect(
      owner.readPrepared({
        params: { agentId: "main", sessionKey: "agent:main:closed" },
        identity: "closed",
        readSource: { agentId: "main", path: "/synthetic/agent.sqlite" },
        source: null,
      }),
    ).toBeUndefined();
  } finally {
    await owner.stop();
    await scheduler.stop();
  }
});

it("releases an invalidated prepared source after its last watcher leaves", async ({
  onTestFinished,
}) => {
  const { spyOnSessionPrLoader, createTestSessionPrReadSource } =
    await import("./control-ui-session-pr-subscriptions.test-support.js");
  const { expectCollected } = await import("../test-utils/retention.js");
  const scheduler = createTestGatewayScheduler();
  const readSource = createTestSessionPrReadSource(onTestFinished);
  let selected: ControlUiSessionPrTarget | undefined;
  const loader = spyOnSessionPrLoader(async () => ({ pullRequests: [], rateLimited: false }));
  const owner = createControlUiSessionPullRequestSubscriptions({
    scheduler,
    prepareRead: async () => async () => selected,
    broadcastToConnIds: () => {},
  });
  async function retireWatchedSource() {
    selected = {
      params: { agentId: "main", sessionKey: "agent:main:watched-retention" },
      identity: "watched-retention",
      readSource,
      source: null,
    };
    await owner.replace("viewer", [selected.params.sessionKey]);
    owner.readPrepared(selected, () => false);
    const retired = new WeakRef(selected.params);
    sessionChanges.emit({ ...selected.params, facts: { kind: "removed" } });
    owner.unsubscribe("viewer");
    loader.mockClear();
    selected = undefined;
    return retired;
  }
  try {
    await expectCollected(await retireWatchedSource());
  } finally {
    await owner.stop();
    await scheduler.stop();
  }
});
