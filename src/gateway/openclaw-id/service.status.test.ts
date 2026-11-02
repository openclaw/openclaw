import { describe, expect, it } from "vitest";
import { linkedClaw, serviceFor } from "./openclaw-id.test-support.js";

describe("OpenClaw ID link status", () => {
  it("is unpublished until the claw is registered with Discovery", async () => {
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority);
    expect((await service.linkStatus()).publication).toBeUndefined();
  });

  it("reports the recorded publication after a restart, before any new attempt", async () => {
    const claw = await linkedClaw();
    await claw.authority.recordDiscovery({
      owner_account_id: "acct-owner",
      published_binding_seq: 1,
      published_snapshot_seq: 4,
    });
    const { service } = serviceFor(claw.authority);
    expect((await service.linkStatus()).publication).toEqual({
      state: "published",
      ownerAccountId: "acct-owner",
      snapshotSeq: 4,
      snapshotIssuedAt: 0,
    });
  });
});
