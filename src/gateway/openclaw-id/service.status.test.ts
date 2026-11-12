import { describe, expect, it } from "vitest";
import { formatIrohEndpointKey } from "../../../packages/openclaw-id-protocol/src/index.js";
import { linkedClaw, serviceFor } from "./openclaw-id.test-support.js";

describe("OpenClaw ID link status", () => {
  it("rejects oversized Discovery metadata without blocking later authority writes", async () => {
    const claw = await linkedClaw();
    for (const field of ["owner_account_id", "mailbox_cursor"] as const) {
      await expect(
        claw.authority.recordDiscovery({ [field]: "\u0001".repeat(257) }),
      ).rejects.toThrow("at most 256");
    }
    await expect(
      claw.authority.recordVerifiedAccount({
        sub: "x".repeat(257),
        name: null,
        email: null,
        exp: 1,
      }),
    ).rejects.toThrow("at most 256");
    expect(
      await claw.authority.submit(
        await claw.sign({
          op: "add",
          account_id: "member",
          role: "viewer",
          peer_keys: [formatIrohEndpointKey(new Uint8Array(32).fill(12))],
          invite_id: null,
        }),
        "tunnel",
      ),
    ).toMatchObject({ ok: true });
    // A normal persisted update still commits after the rejected remote metadata.
    await claw.authority.recordDiscovery({ mailbox_cursor: "unchanged-authority" });
    expect(claw.authority.current()?.discovery.mailbox_cursor).toBe("unchanged-authority");
    expect((await claw.authority.admittedPeerKeys()).admitted).toContain(claw.w1);
  });

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
