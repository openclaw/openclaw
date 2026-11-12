// Canonical-profile integration, through real invitation approval, sweep and database reopen.
import { expect, vi } from "vitest";
import { stateTest } from "../../plugin-state/plugin-state-fixtures.test-support.js";
import { createCorePluginStateKeyedStore } from "../../plugin-state/plugin-state-store.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { createOpenClawIdAuthority } from "./authority.js";
import { readStoredClaw, writeStoredClaw } from "./claw-store.js";
import { fullClaw } from "./claw-store.test-support.js";
import { linkedClaw, ownerInvite, redemptionMail, serviceFor } from "./openclaw-id.test-support.js";

const it = stateTest("openclaw-id-member-profile-persistence");

it("retains approved member display in canonical profiles after invite sweep and restart", async ({
  state,
}) => {
  state.applyEnv();
  const store = { read: readStoredClaw, write: writeStoredClaw };
  const claw = await linkedClaw(store);
  const { service } = serviceFor(claw.authority);
  const invite = await ownerInvite(claw, { email: "bob@example.test", expiresIn: 60 });
  expect(
    await claw.authority.registerInvite({ cap: invite.cap, proofKey: invite.proofKey }, "tunnel"),
  ).toMatchObject({ ok: true });
  const mail = await redemptionMail({
    clawId: claw.clawId,
    inviteId: invite.inviteId,
    proofKey: invite.proofKey,
    accountId: "acct-bob",
    email: "bob@example.test",
  });
  expect(
    await claw.authority.redeem(
      mail.message.payload.kind === "invite_redemption" ? mail.message.payload.redemption : null,
      mail.message.from,
    ),
  ).toMatchObject({ ok: true });
  const approvedAt = Math.floor(Date.now() / 1000);
  expect(
    await claw.authority.submit(
      await claw.sign({
        op: "add",
        account_id: "acct-bob",
        role: "operator",
        peer_keys: [mail.peerKey],
        invite_id: invite.inviteId,
      }),
      "tunnel",
    ),
  ).toMatchObject({ ok: true });
  try {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 361_000);
    const next = await ownerInvite(claw, { email: "carol@example.test" });
    expect(
      await claw.authority.registerInvite({ cap: next.cap, proofKey: next.proofKey }, "tunnel"),
    ).toMatchObject({ ok: true });
    expect(claw.authority.current()?.invite_reports?.[invite.inviteId]).toBeUndefined();
    expect((await service.linkStatus()).members).toMatchObject([
      { accountId: "acct-bob", email: "bob@example.test", displayName: "Bob", approvedAt },
    ]);
  } finally {
    vi.useRealTimers();
  }
  await closeOpenClawStateDatabaseAsync();
  const restored = createOpenClawIdAuthority(store);
  await restored.load();
  expect(await restored.memberProfiles(["acct-bob"])).toMatchObject({
    "acct-bob": { email: "bob@example.test", displayName: "Bob" },
  });
  expect(restored.current()?.member_approved_at?.["acct-bob"]).toBe(approvedAt);
});

it("migrates prior approved reports into OCID profiles before dropping their source", async ({
  state,
}) => {
  state.applyEnv();
  const record = fullClaw();
  const member = Object.values(record.authority!.members)[0]!;
  record.authority!.members = { "acct-existing": member };
  record.authority!.invites = {};
  record.invite_reports = {
    old: {
      account_id: "acct-existing",
      email: "existing@example.test",
      display_name: "Existing Member",
      location_hint: null,
      resolution: "approved",
      resolved_at: 1234,
    },
  };
  record.token_bindings = [];
  delete record.member_approved_at;
  const legacy = createCorePluginStateKeyedStore<unknown>({
    ownerId: "core:openclaw-id",
    namespace: "claw",
    retention: "retained",
  });
  await legacy.register("current", record);
  const authority = createOpenClawIdAuthority();
  await authority.load();
  expect(await authority.memberProfiles(["acct-existing"])).toMatchObject({
    "acct-existing": { email: "existing@example.test", displayName: "Existing Member" },
  });
  expect(authority.current()?.member_approved_at).toEqual({ "acct-existing": 1234 });
  expect(authority.current()?.invite_reports).toEqual({});
  await closeOpenClawStateDatabaseAsync();
  expect((await readStoredClaw())?.member_approved_at).toEqual({ "acct-existing": 1234 });
});

it("keeps canonical email and assigns a new approval time on direct member re-add", async ({
  state,
}) => {
  state.applyEnv();
  const claw = await linkedClaw({ read: readStoredClaw, write: writeStoredClaw });
  const invite = await ownerInvite(claw, { email: "bob@example.test" });
  await claw.authority.registerInvite({ cap: invite.cap, proofKey: invite.proofKey }, "tunnel");
  const mail = await redemptionMail({
    clawId: claw.clawId,
    inviteId: invite.inviteId,
    proofKey: invite.proofKey,
    accountId: "acct-bob",
    email: "bob@example.test",
  });
  await claw.authority.redeem(
    mail.message.payload.kind === "invite_redemption" ? mail.message.payload.redemption : null,
    mail.message.from,
  );
  expect(
    await claw.authority.submit(
      await claw.sign({
        op: "add",
        account_id: "acct-bob",
        role: "operator",
        peer_keys: [mail.peerKey],
        invite_id: invite.inviteId,
      }),
      "tunnel",
    ),
  ).toMatchObject({ ok: true });
  expect(
    await claw.authority.submit(
      await claw.sign({ op: "remove", account_id: "acct-bob" }),
      "tunnel",
    ),
  ).toMatchObject({ ok: true });
  try {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    expect(
      await claw.authority.submit(
        await claw.sign({
          op: "add",
          account_id: "acct-bob",
          role: "operator",
          peer_keys: [mail.peerKey],
          invite_id: null,
        }),
        "tunnel",
      ),
    ).toMatchObject({ ok: true });
    expect(claw.authority.current()?.member_approved_at?.["acct-bob"]).toBe(
      Math.floor(Date.now() / 1000),
    );
    expect(await claw.authority.memberProfiles(["acct-bob"])).toMatchObject({
      "acct-bob": { email: "bob@example.test", displayName: "Bob" },
    });
  } finally {
    vi.useRealTimers();
  }
});
