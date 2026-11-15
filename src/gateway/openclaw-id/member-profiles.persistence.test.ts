// Canonical-profile integration, through real invitation approval, sweep and database reopen.
import { expect, vi } from "vitest";
import {
  bytesToBase64url,
  generateEd25519Signer,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { withEngineStoreAdmission } from "../../infra/database-engine/admission-scope.js";
import { stateTest } from "../../plugin-state/plugin-state-fixtures.test-support.js";
import { createCorePluginStateKeyedStore } from "../../plugin-state/plugin-state-store.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  readOpenClawIdLinkedProfile,
  linkCanonicalOpenClawIdUserProfile,
} from "../../state/user-profile-openclaw-id.js";
import {
  ensureCanonicalGatewayOwnerProfile,
  ensureCanonicalUserProfileForEmail,
  mergeCanonicalUserProfiles,
  setCanonicalUserProfileDisplayName,
} from "../../state/user-profile-writes.js";
import { openclawIdHandlers } from "../server-methods/openclaw-id.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { createOpenClawIdAuthority } from "./authority.js";
import { readStoredClaw, writeStoredClaw } from "./claw-store.js";
import { fullClaw } from "./claw-store.test-support.js";
import { createDiscoveryClient } from "./discovery-client.js";
import { linkedClaw, ownerInvite, redemptionMail, serviceFor } from "./openclaw-id.test-support.js";
import { publishClaw } from "./publisher.js";

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
  const { service } = serviceFor(claw.authority);
  const bob = (await claw.authority.memberProfiles(["acct-bob"]))["acct-bob"]!;
  expect((await service.prepareMemberProfileCheck(bob.id))()).toBe(true);
  expect(
    await claw.authority.submit(
      await claw.sign({ op: "remove", account_id: "acct-bob" }),
      "tunnel",
    ),
  ).toMatchObject({ ok: true });
  expect((await service.prepareMemberProfileCheck(bob.id))()).toBe(false);
  await service.stop();
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

it("registers only eligible local profiles through RPC, retains selection across restart, and binds only on signed approval", async ({
  state,
}) => {
  state.applyEnv();
  const person = await ensureCanonicalUserProfileForEmail("existing@example.test");
  await setCanonicalUserProfileDisplayName(person.id, "Existing Person");
  const owner = await ensureCanonicalGatewayOwnerProfile("Owner");
  const claw = await linkedClaw({ read: readStoredClaw, write: writeStoredClaw });
  const { service } = serviceFor(claw.authority);
  const invite = await ownerInvite(claw, { email: "bob@example.test", expiresIn: 60 });
  const register = async (existingProfileId: unknown) => {
    const respond = vi.fn();
    await openclawIdHandlers["openclawId.authority"]!({
      params: {
        action: "register_invite",
        cap: invite.cap,
        proofKey: bytesToBase64url(invite.proofKey),
        existingProfileId,
      },
      client: { internal: { isLocalClient: true } },
      context: {
        openclawIdService: service,
        getRuntimeConfig: () => ({ gateway: { openclawId: { enabled: true } } }),
      },
      respond,
    } as unknown as GatewayRequestHandlerOptions);
    return respond.mock.calls[0];
  };
  try {
    expect((await service.linkStatus()).existingProfiles).toEqual([
      { id: person.id, displayName: "Existing Person" },
    ]);
    expect((await register(42))?.[0]).toBe(false);
    for (const id of [owner.id, "missing-profile"]) {
      expect((await register(id))?.[2]).toMatchObject({ details: { code: "profile_unavailable" } });
    }
    expect(claw.authority.current()?.authority?.invites).toEqual({});
    expect((await register(person.id))?.[0]).toBe(true);
    expect((await register(owner.id))?.[2]).toMatchObject({ details: { code: "invite_used" } });
  } finally {
    await service.stop();
  }
  await closeOpenClawStateDatabaseAsync();
  const restored = createOpenClawIdAuthority();
  await restored.load();
  const { service: restarted } = serviceFor(restored);
  const mail = await redemptionMail({
    clawId: claw.clawId,
    inviteId: invite.inviteId,
    proofKey: invite.proofKey,
    accountId: "acct-bob",
    email: "bob@example.test",
  });
  try {
    expect((await restarted.linkStatus()).invites?.[0]?.existingProfile).toEqual({
      id: person.id,
      displayName: "Existing Person",
    });
    expect(await restored.redeem(mail.message.payload.redemption, mail.message.from)).toMatchObject(
      { ok: true },
    );
    expect(await readOpenClawIdLinkedProfile("acct-bob")).toBeNull();
    expect(await restored.resolvePeer(mail.peerKey)).toBeUndefined();
    const approval = await claw.sign({
      op: "add",
      account_id: "acct-bob",
      role: "operator",
      peer_keys: [mail.peerKey],
      invite_id: invite.inviteId,
    });
    expect(
      await restored.submit({ ...approval, sig: bytesToBase64url(new Uint8Array(64)) }, "tunnel"),
    ).toMatchObject({
      ok: false,
      code: "bad_signature",
    });
    expect(await readOpenClawIdLinkedProfile("acct-bob")).toBeNull();
    expect(await restored.submit(approval, "tunnel")).toMatchObject({ ok: true });
    expect(await readOpenClawIdLinkedProfile("acct-bob")).toMatchObject({ profileId: person.id });
    expect(await restored.resolvePeer(mail.peerKey)).toMatchObject({
      kind: "member",
      accountId: "acct-bob",
    });
    expect((await restarted.linkStatus()).members).toMatchObject([
      { displayName: "Existing Person", email: "bob@example.test" },
    ]);
    expect(JSON.stringify(restored.current()?.authority)).not.toContain(person.id);
    expect(JSON.stringify(invite.cap)).not.toContain(person.id);
    const requests: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      requests.push(await new Response(init?.body).text());
      return Response.json({ owner_account_id: "owner" });
    });
    const signer = await generateEd25519Signer();
    expect(
      await publishClaw({
        record: restored.current()!,
        relayUrl: "https://relay.example.test",
        client: createDiscoveryClient({
          baseUrl: "https://discovery.example.test",
          signer,
          fetchImpl: fetcher,
        }),
        signer,
        enrollmentCode: "synthetic-code",
      }),
    ).toMatchObject({ state: "published" });
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.join("\n")).not.toContain(person.id);
    expect(requests.join("\n")).not.toContain("Existing Person");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 361_000);
    const next = await ownerInvite(claw, { email: "next@example.test" });
    expect(
      await restored.registerInvite({ cap: next.cap, proofKey: next.proofKey }, "tunnel"),
    ).toMatchObject({ ok: true });
    expect(restored.current()?.invite_reports?.[invite.inviteId]).toBeUndefined();
  } finally {
    vi.useRealTimers();
    await restarted.stop();
  }
  await closeOpenClawStateDatabaseAsync();
  expect(await readOpenClawIdLinkedProfile("acct-bob")).toMatchObject({ profileId: person.id });
});

for (const change of ["merged", "deleted", "taken", "account-linked", "same-account"] as const) {
  it(`approves safely when the selected profile is ${change} before approval`, async ({
    state,
  }) => {
    state.applyEnv();
    const person = await ensureCanonicalUserProfileForEmail("existing@example.test");
    const other = await ensureCanonicalUserProfileForEmail("other@example.test");
    const claw = await linkedClaw({ read: readStoredClaw, write: writeStoredClaw });
    const invite = await ownerInvite(claw, { email: "bob@example.test" });
    expect(
      await claw.authority.registerInvite(
        { cap: invite.cap, proofKey: invite.proofKey, existingProfileId: person.id },
        "tunnel",
      ),
    ).toMatchObject({ ok: true });
    const mail = await redemptionMail({
      clawId: claw.clawId,
      inviteId: invite.inviteId,
      proofKey: invite.proofKey,
      accountId: "acct-bob",
      email: "bob@example.test",
    });
    expect(
      await claw.authority.redeem(mail.message.payload.redemption, mail.message.from),
    ).toMatchObject({ ok: true });
    if (change === "merged") {
      await mergeCanonicalUserProfiles(person.id, other.id);
    } else if (change === "deleted") {
      // Offline fixture removal models a profile deleted after the invitation was issued.
      await closeOpenClawStateDatabaseAsync();
      const { db } = openOpenClawStateDatabase();
      withEngineStoreAdmission(() =>
        db.prepare("DELETE FROM user_profiles WHERE id = ?").run(person.id),
      );
      await closeOpenClawStateDatabaseAsync();
    } else {
      await linkCanonicalOpenClawIdUserProfile({
        profileId: change === "account-linked" ? other.id : person.id,
        accountId: change === "taken" ? "acct-other" : "acct-bob",
        email: null,
      });
    }
    expect(await claw.authority.resolvePeer(mail.peerKey)).toBeUndefined();
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
    expect(await claw.authority.resolvePeer(mail.peerKey)).toMatchObject({ kind: "member" });
    const linked = await readOpenClawIdLinkedProfile("acct-bob");
    const outcome = claw.authority.current()?.invite_reports?.[invite.inviteId]?.existingProfile;
    if (change === "same-account") {
      expect(linked?.profileId).toBe(person.id);
      expect(outcome?.fallbackReason).toBeUndefined();
    } else {
      expect(linked?.profileId).not.toBe(person.id);
      expect(outcome?.fallbackReason).toMatch(/instead/);
      if (change === "account-linked") {
        expect(linked?.profileId).toBe(other.id);
      }
      if (change === "merged") {
        expect(linked?.profileId).not.toBe(other.id);
      }
      if (change === "taken") {
        expect(await readOpenClawIdLinkedProfile("acct-other")).toMatchObject({
          profileId: person.id,
        });
      }
    }
    await closeOpenClawStateDatabaseAsync();
    expect((await readStoredClaw())?.invite_reports?.[invite.inviteId]?.existingProfile).toEqual(
      outcome,
    );
  });
}
