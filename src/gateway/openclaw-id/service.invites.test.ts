import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToBase64url } from "../../../packages/openclaw-id-protocol/src/index.js";
import { applyMailboxMessage } from "./mailbox-reader.js";
import {
  linkedClaw,
  ownerInvite,
  redemptionMail,
  serviceFor,
  type LinkedClaw,
} from "./openclaw-id.test-support.js";

// Delivers a redemption through the mailbox path the Gateway's reader uses.
async function redeem(claw: LinkedClaw, invite: Awaited<ReturnType<typeof ownerInvite>>) {
  const mail = await redemptionMail({
    clawId: claw.clawId,
    inviteId: invite.inviteId,
    proofKey: invite.proofKey,
    accountId: "acct-bob",
    email: "bob@example.com",
  });
  const [result] = await applyMailboxMessage(mail.message, {
    submit: (statement) => claw.authority.submit(statement, "mailbox"),
    redeem: (redemption, sender) => claw.authority.redeem(redemption, sender),
  });
  return { result, peerKey: mail.peerKey };
}

async function invitedClaw() {
  const claw = await linkedClaw();
  const { service, log } = serviceFor(claw.authority);
  const invite = await ownerInvite(claw, { email: "bob@example.com" });
  expect(
    await service.registerInvite("local_operator", { cap: invite.cap, proofKey: invite.proofKey }),
  ).toMatchObject({ ok: true });
  return { claw, service, invite, log };
}

describe("Gateway invites (spec section 6.3)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers an owner-signed invite and lists it as open without the proof key", async () => {
    const { service, invite } = await invitedClaw();
    const link = await service.linkStatus();
    expect(link.invites).toEqual([
      expect.objectContaining({ inviteId: invite.inviteId, status: "open", role: "operator" }),
    ]);
    expect(JSON.stringify(link)).not.toContain(bytesToBase64url(invite.proofKey));
  });

  it.each(["mailbox", undefined] as const)(
    "refuses to register an invite over %s",
    async (channel) => {
      const claw = await linkedClaw();
      const { service } = serviceFor(claw.authority);
      const invite = await ownerInvite(claw, { email: "bob@example.com" });
      expect(
        await service.registerInvite(channel, { cap: invite.cap, proofKey: invite.proofKey }),
      ).toMatchObject({ ok: false, code: "not_direct" });
    },
  );

  it("refuses a proof key that does not match the cap", async () => {
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority);
    const invite = await ownerInvite(claw, { email: "bob@example.com" });
    expect(
      await service.registerInvite("tunnel", { cap: invite.cap, proofKey: new Uint8Array(32) }),
    ).toMatchObject({ ok: false, code: "bad_proof" });
  });

  it("records a mailbox redemption as pending with the reported sender, admitting nothing", async () => {
    const { claw, service, invite } = await invitedClaw();
    const { result, peerKey } = await redeem(claw, invite);
    expect(result).toMatchObject({ ok: true, status: "pending" });
    expect((await claw.authority.admittedPeerKeys()).admitted).not.toContain(peerKey);
    const [view] = (await service.linkStatus()).invites ?? [];
    expect(view).toMatchObject({
      status: "pending",
      pending: {
        accountId: "acct-bob",
        peerKey,
        reported: { email: "bob@example.com", displayName: "Bob", locationHint: "Lisbon, PT" },
      },
    });
    expect(view?.pending?.decideBy).toBe((view?.pending?.requestedAt ?? 0) + 7 * 86400);
  });

  it("approves a pending redemption sent directly by an owner device and admits the invitee", async () => {
    const { claw, service, invite } = await invitedClaw();
    const { peerKey } = await redeem(claw, invite);
    const approval = await claw.sign({
      op: "add",
      account_id: "acct-bob",
      role: "operator",
      peer_keys: [peerKey],
      invite_id: invite.inviteId,
    });
    expect(await service.submitStatement("tunnel", approval)).toMatchObject({ ok: true });
    expect((await claw.authority.admittedPeerKeys()).admitted).toContain(peerKey);
    const link = await service.linkStatus();
    expect(link.members).toEqual([
      expect.objectContaining({ accountId: "acct-bob", email: "bob@example.com" }),
    ]);
    expect(link.invites?.[0]).toMatchObject({ status: "approved" });
  });

  it("denies a pending redemption: the invite is used up and nobody is admitted", async () => {
    const { claw, service, invite } = await invitedClaw();
    const { peerKey } = await redeem(claw, invite);
    const deny = await claw.sign({ op: "deny_invite", invite_id: invite.inviteId });
    expect(await service.submitStatement("local_operator", deny)).toMatchObject({ ok: true });
    expect((await claw.authority.admittedPeerKeys()).admitted).not.toContain(peerKey);
    expect((await service.linkStatus()).invites?.[0]).toMatchObject({ status: "denied" });
    const again = await redeem(claw, invite);
    expect(again.result).toMatchObject({ ok: false, code: "invite_used" });
  });

  it("expires a pending redemption after seven days and refuses a late approval", async () => {
    const { claw, service, invite } = await invitedClaw();
    const { peerKey } = await redeem(claw, invite);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 7 * 86400 * 1000 + 1000);
    expect((await service.linkStatus()).invites?.[0]).toMatchObject({ status: "expired" });
    const late = await claw.sign({
      op: "add",
      account_id: "acct-bob",
      role: "operator",
      peer_keys: [peerKey],
      invite_id: invite.inviteId,
    });
    expect(await service.submitStatement("tunnel", late)).toMatchObject({
      ok: false,
      code: "invite_not_pending",
    });
    expect((await claw.authority.admittedPeerKeys()).admitted).not.toContain(peerKey);
    expect((await service.linkStatus()).invites?.[0]).toMatchObject({ status: "expired" });
  });

  it("keeps a redemption pending inside the seven-day window", async () => {
    const { claw, service, invite } = await invitedClaw();
    await redeem(claw, invite);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 86400 * 1000);
    expect((await service.linkStatus()).invites?.[0]).toMatchObject({ status: "pending" });
  });
});
