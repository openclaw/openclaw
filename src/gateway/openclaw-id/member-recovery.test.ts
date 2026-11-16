import { describe, expect, it, vi } from "vitest";
import {
  createMemberRecoveryKit,
  fingerprint,
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateEd25519Signer,
  randomBytes,
  signStatement,
  type MailboxMessage,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { createOpenClawIdAuthority } from "./authority.js";
import { applyMailboxMessage } from "./mailbox-reader.js";
import {
  linkedClaw,
  memoryStore,
  ownerInvite,
  redemptionMail,
  serviceFor,
} from "./openclaw-id.test-support.js";

describe("Gateway member recovery", () => {
  it.each([undefined, null, {}, { type: "MembershipChange", body: null }])(
    "refuses malformed recovery mail before dispatch",
    async (statement) => {
      const sink = { submit: vi.fn(), redeem: vi.fn(), redeemNode: vi.fn() };
      const message = {
        payload: { kind: "member_recovery", statement },
      } as unknown as MailboxMessage;
      expect(await applyMailboxMessage(message, sink)).toMatchObject([
        { ok: false, code: "unsupported" },
      ]);
      expect(sink.submit).not.toHaveBeenCalled();
    },
  );

  it("persists the kit, admits the same account through mail, exposes provenance, then removes all authority", async () => {
    const store = memoryStore();
    const claw = await linkedClaw(store);
    const invite = await ownerInvite(claw, { email: "recovery@example.test", role: "viewer" });
    expect(
      await claw.authority.registerInvite({ cap: invite.cap, proofKey: invite.proofKey }, "tunnel"),
    ).toMatchObject({ ok: true });
    const mail = await redemptionMail({
      clawId: claw.clawId,
      inviteId: invite.inviteId,
      proofKey: invite.proofKey,
      accountId: "recovery-member",
      email: "recovery@example.test",
    });
    expect(
      await claw.authority.redeem(mail.message.payload.redemption, mail.message.from),
    ).toMatchObject({ ok: true });
    expect(
      await claw.authority.submit(
        await claw.sign({
          op: "add",
          account_id: "recovery-member",
          role: "viewer",
          peer_keys: [mail.peerKey],
          invite_id: invite.inviteId,
        }),
        "tunnel",
      ),
    ).toMatchObject({ ok: true });
    const { signer: kit } = await createMemberRecoveryKit({
      claw_id: claw.clawId,
      account_id: "recovery-member",
      hostname: claw.prep.hostname,
      root_fp: await fingerprint(formatEd25519PublicKey(claw.root.publicKey)),
    });
    const registration = await claw.sign(
      {
        op: "set_member_recovery_kit",
        account_id: "recovery-member",
        device_pub: formatEd25519PublicKey(kit.publicKey),
      },
      mail.signer,
    );
    expect(await claw.authority.submit(registration, "tunnel")).toMatchObject({ ok: true });
    const restarted = createOpenClawIdAuthority(store);
    await restarted.load();
    const { service } = serviceFor(restarted);
    expect(await restarted.memberView(mail.peerKey)).toMatchObject({
      account_id: "recovery-member",
      role: "viewer",
      recovery_kit: {
        device_pub: formatEd25519PublicKey(kit.publicKey),
        saved_at: registration.body.issued_at,
      },
    });
    expect((await restarted.ownerView(claw.w1))?.members[0]?.recovery_kit).toEqual({
      device_pub: formatEd25519PublicKey(kit.publicKey),
      saved_at: registration.body.issued_at,
    });
    expect((await service.linkStatus()).members).toMatchObject([{ recoveryKit: true }]);
    const browser = await generateEd25519Signer();
    const peer = formatIrohEndpointKey(randomBytes(32));
    const recovered = await signStatement(
      "MembershipChange",
      {
        claw_id: claw.clawId,
        seq: restarted.current()!.authority!.seq + 1,
        issued_at: Math.floor(Date.now() / 1000),
        target: {
          op: "add_member_device",
          account_id: "recovery-member",
          device_pub: formatEd25519PublicKey(browser.publicKey),
          peer_key: peer,
          label: "Recovered browser",
        },
      },
      kit,
    );
    const sink = {
      submit: (statement: unknown) => restarted.submit(statement, "mailbox"),
      redeem: (redemption: unknown, sender: Parameters<typeof restarted.redeem>[1]) =>
        restarted.redeem(redemption, sender),
      redeemNode: (redemption: unknown) => restarted.redeemNode(redemption),
    };
    const recoveryMail = {
      ...mail.message,
      payload: { kind: "member_recovery" as const, statement: recovered },
    };
    vi.spyOn(store, "write").mockRejectedValueOnce(new Error("storage unavailable"));
    await expect(applyMailboxMessage(recoveryMail, sink)).rejects.toThrow("storage unavailable");
    expect((await restarted.admittedPeerKeys()).admitted).not.toContain(peer);
    expect((await service.linkStatus()).recoveryUses).toEqual([]);
    expect(await applyMailboxMessage(recoveryMail, sink)).toMatchObject([{ ok: true }]);
    const use = {
      seq: recovered.body.seq,
      accountId: "recovery-member",
      memberName: "Bob",
      deviceLabel: "Recovered browser",
      peerKey: peer,
      peerFp: await fingerprint(peer),
      usedAt: expect.any(Number),
    };
    expect((await service.linkStatus()).recoveryUses).toEqual([use]);
    expect((await createOpenClawIdAuthority(store).load())?.member_recovery_uses).toEqual([use]);
    expect(await applyMailboxMessage(recoveryMail, sink)).toMatchObject([
      { ok: false, code: "seq_conflict" },
    ]);
    expect((await service.linkStatus()).recoveryUses).toEqual([use]);
    expect(await restarted.memberView(peer)).not.toHaveProperty("recoveryUses");
    expect(await restarted.memberView(peer)).toMatchObject({
      account_id: "recovery-member",
      role: "viewer",
      devices: expect.arrayContaining([
        expect.objectContaining({
          peer_key: peer,
          approved_by: {
            kind: "member_recovery_kit",
            device_fp: await fingerprint(formatEd25519PublicKey(kit.publicKey)),
          },
        }),
      ]),
    });
    expect((await restarted.admittedPeerKeys()).admitted).not.toContain(
      formatIrohEndpointKey(kit.publicKey),
    );
    expect(
      await restarted.submit(
        await signStatement(
          "MembershipChange",
          {
            claw_id: claw.clawId,
            seq: restarted.current()!.authority!.seq + 1,
            issued_at: Math.floor(Date.now() / 1000),
            target: { op: "remove", account_id: "recovery-member" },
          },
          claw.device,
        ),
        "tunnel",
      ),
    ).toMatchObject({ ok: true });
    expect(await restarted.memberView(peer)).toBeUndefined();
    const fresh = await signStatement(
      "MembershipChange",
      { ...recovered.body, seq: restarted.current()!.authority!.seq + 1 },
      kit,
    );
    expect(
      await applyMailboxMessage(
        { ...mail.message, payload: { kind: "member_recovery", statement: fresh } },
        sink,
      ),
    ).toMatchObject([{ ok: false, code: "not_an_owner" }]);
    expect((await restarted.admittedPeerKeys()).admitted).not.toContain(peer);
    expect((await service.linkStatus()).recoveryUses).toEqual([use]);
  });
});
