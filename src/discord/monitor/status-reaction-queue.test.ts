import { afterEach, describe, expect, it } from "vitest";
import {
  __testing,
  claimDiscordStatusReactionQueue,
  releaseDiscordStatusReactionQueue,
  waitForDiscordStatusReactionQueueTurn,
} from "./status-reaction-queue.js";

afterEach(() => {
  __testing.resetQueueForTests();
});

describe("status-reaction-queue", () => {
  it("marks only later messages in same channel as backlog", () => {
    const first = claimDiscordStatusReactionQueue("c1", "m1");
    const second = claimDiscordStatusReactionQueue("c1", "m2");

    expect(first).toMatchObject({ hasPriorPendingWork: false, position: 0 });
    expect(second).toMatchObject({ hasPriorPendingWork: true, position: 1 });
  });

  it("isolates queue lanes by channel", () => {
    const c1 = claimDiscordStatusReactionQueue("c1", "m1");
    const c2 = claimDiscordStatusReactionQueue("c2", "m2");

    expect(c1.hasPriorPendingWork).toBe(false);
    expect(c2.hasPriorPendingWork).toBe(false);
  });

  it("waits until the message reaches the lane head", async () => {
    claimDiscordStatusReactionQueue("c1", "m1");
    claimDiscordStatusReactionQueue("c1", "m2");

    let resolved = false;
    const waitTurn = waitForDiscordStatusReactionQueueTurn("c1", "m2").then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    releaseDiscordStatusReactionQueue("c1", "m1");
    await waitTurn;
    expect(resolved).toBe(true);
  });

  it("is idempotent for duplicate claims and cleans up on release", () => {
    claimDiscordStatusReactionQueue("c1", "m1");
    const duplicate = claimDiscordStatusReactionQueue("c1", "m1");
    claimDiscordStatusReactionQueue("c1", "m2");
    releaseDiscordStatusReactionQueue("c1", "m1");

    expect(duplicate).toMatchObject({ hasPriorPendingWork: false, position: 0 });
    expect(__testing.getQueueSnapshot()).toEqual({
      size: 1,
      lanes: [{ channelId: "c1", messageIds: ["m2"] }],
    });
  });
});
