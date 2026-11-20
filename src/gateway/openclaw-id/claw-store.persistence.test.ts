import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, vi } from "vitest";
// Real shared-state worker proof: bounded sections, restart recovery and one-transaction rollback.
import {
  formatIrohEndpointKey,
  signStatement,
  type MailboxMessage,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { withEngineStoreAdmission } from "../../infra/database-engine/admission-scope.js";
import { sqliteWorkerOwnerProbe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { stateTest } from "../../plugin-state/plugin-state-fixtures.test-support.js";
import { createCorePluginStateKeyedStore } from "../../plugin-state/plugin-state-store.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import * as stateWriter from "../../state/openclaw-state-worker-store.js";
import { createOpenClawIdAuthority } from "./authority.js";
import { readStoredClaw, writeStoredClaw } from "./claw-store.js";
import { fullClaw } from "./claw-store.test-support.js";
import { stageGatewayKey } from "./gateway-key.js";
import { applyMailboxMessage } from "./mailbox-reader.js";
import { linkedClaw, ownerInvite, redemptionMail, serviceFor } from "./openclaw-id.test-support.js";
import { ed25519PublicKeyHex, loadOrCreateEndpointKey } from "./tunnel-child/keyfile.js";
import * as tunnelRuntime from "./tunnel-runtime.js";

const it = stateTest("openclaw-id-claw-persistence");
afterEach(() => vi.restoreAllMocks());

it("saves an escaped full-capacity claw and restores every section after reopening", async ({
  state,
}) => {
  state.applyEnv();
  const record = fullClaw();
  await writeStoredClaw(record);
  await closeOpenClawStateDatabaseAsync();
  expect(await readStoredClaw()).toMatchObject(record);
});

it("rolls every section back when a later section fails inside the real writer transaction", async ({
  state,
}) => {
  state.applyEnv();
  const record = fullClaw();
  await writeStoredClaw(record);
  const { db } = openOpenClawStateDatabase();
  // Synthetic schema fault rejects a later INSERT, after current and owner-devices were replaced.
  withEngineStoreAdmission(() =>
    db.exec(`
    CREATE TRIGGER refuse_claw_members BEFORE INSERT ON plugin_state_entries
    WHEN NEW.plugin_id = 'core:openclaw-id' AND NEW.entry_key = 'members'
    BEGIN SELECT RAISE(ABORT, 'synthetic claw partition failure'); END;
  `),
  );
  const changed = { ...record, hostname: "changed.example.test", authority: null };
  try {
    await expect(writeStoredClaw(changed)).rejects.toMatchObject({
      cause: { message: expect.stringContaining("synthetic claw partition failure") },
    });
  } finally {
    withEngineStoreAdmission(() => db.exec("DROP TRIGGER refuse_claw_members"));
  }
  await closeOpenClawStateDatabaseAsync();
  expect(await readStoredClaw()).toMatchObject(record);
});

it("restores browser notices and cancellation receipts without changing membership or profiles", async ({
  state,
}) => {
  state.applyEnv();
  const store = { read: readStoredClaw, write: writeStoredClaw };
  const claw = await linkedClaw(store);
  const peer = formatIrohEndpointKey(new Uint8Array(32).fill(42));
  expect(
    await claw.authority.submit(
      await claw.sign({
        op: "add",
        account_id: "member",
        role: "viewer",
        peer_keys: [peer],
        invite_id: null,
      }),
      "tunnel",
    ),
  ).toMatchObject({ ok: true });
  const before = structuredClone(claw.authority.current()!.authority);
  const now = Math.floor(Date.now() / 1000);
  const message: MailboxMessage = {
    message_id: "browser-mail",
    claw_id: claw.clawId,
    to: "gateway",
    from: {
      account_id: "member",
      display_name: "Untrusted",
      email: null,
      device_fp: null,
      reported_by: "openclaw-id",
    },
    received_at: now,
    expires_at: now + 86400,
    location_hint: "x".repeat(400),
    payload: {
      kind: "member_browser_request",
      request_id: "a".repeat(32),
      action: "request",
      member_account_id: "member",
      label: "Browser",
      expires_at: now + 1800,
    },
  };
  const profiles = await claw.authority.memberProfiles(["member"]);
  expect(await claw.authority.memberBrowserRequest(message)).toMatchObject({
    ok: true,
    events: [],
  });
  await closeOpenClawStateDatabaseAsync();
  const reopened = createOpenClawIdAuthority(store);
  await reopened.load();
  expect(reopened.current()?.authority).toEqual(before);
  expect(reopened.current()?.member_browser_requests?.member?.notice).toMatchObject({
    requestId: "a".repeat(32),
    location: "x".repeat(256),
  });
  expect(await reopened.memberProfiles(["member"])).toEqual(profiles);
  if (message.payload.kind !== "member_browser_request") {
    throw new Error("fixture");
  }
  message.payload.action = "cancel";
  expect(await reopened.memberBrowserRequest(message)).toMatchObject({ ok: true });
  for (const char of ["b", "c", "d", "e"]) {
    message.payload.request_id = char.repeat(32);
    expect(await reopened.memberBrowserRequest(message)).toMatchObject({ ok: true });
  }
  await closeOpenClawStateDatabaseAsync();
  const canceled = createOpenClawIdAuthority(store);
  message.payload.action = "request";
  message.payload.request_id = "a".repeat(32);
  expect(await canceled.memberBrowserRequest(message)).toMatchObject({
    ok: false,
    code: "replayed",
  });
  expect(canceled.current()?.member_browser_requests?.member?.notice).toBeNull();
  expect(canceled.current()?.member_browser_requests?.member?.terminal).toHaveLength(3);
  expect(canceled.current()?.member_browser_requests?.member?.blockedUntil).toBe(
    message.payload.expires_at,
  );
  message.payload.request_id = "b".repeat(32);
  expect(await canceled.memberBrowserRequest(message)).toMatchObject({
    ok: false,
    code: "replayed",
  });
  message.payload.request_id = "e".repeat(32);
  expect(await canceled.memberBrowserRequest(message)).toMatchObject({
    ok: false,
    code: "rate_limited",
  });
  expect(canceled.current()?.authority).toEqual(before);
});

it("opens pre-notice v2 rows and adds browser requests without changing schema or other values", async ({
  state,
}) => {
  state.applyEnv();
  const { member_browser_requests: requests, ...record } = fullClaw("Example");
  record.authority!.members = Object.fromEntries(
    Object.entries(record.authority!.members).slice(0, 2),
  );
  record.authority!.owner_devices = Object.fromEntries(
    Object.entries(record.authority!.owner_devices).slice(0, 2),
  );
  record.authority!.invites = {};
  record.invite_reports = {};
  record.member_approved_at = Object.fromEntries(
    Object.entries(record.member_approved_at!).slice(0, 2),
  );
  record.token_bindings = record.token_bindings!.slice(0, 2);
  const { authority, invite_reports, member_approved_at, token_bindings, ...core } = record;
  const { owner_devices, members, invites, ...anchor } = authority!;
  // Persist the v2 row contract used before browser notices, independently of the new row writer.
  const priorRows = {
    current: { ...core, v: 2, authority: anchor },
    "owner-devices": owner_devices,
    members,
    invites,
    "invite-reports": invite_reports,
    "member-approvals": member_approved_at,
    "token-bindings": { v: 1, bindings: token_bindings },
  };
  const store = createCorePluginStateKeyedStore<unknown>({
    ownerId: "core:openclaw-id",
    namespace: "claw",
    retention: "retained",
  });
  for (const [key, value] of Object.entries(priorRows)) {
    await store.register(key, value);
  }
  const unrelated = createCorePluginStateKeyedStore<unknown>({
    ownerId: "core:openclaw-id",
    namespace: "upgrade-sentinel",
    retention: "retained",
  });
  await unrelated.register("untouched", { value: "preserve me" });
  const inspect = () =>
    withEngineStoreAdmission(() => {
      const { db } = openOpenClawStateDatabase();
      return {
        schema: db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all(),
        version: db.prepare("PRAGMA user_version").get(),
        unrelated: db
          .prepare("SELECT * FROM plugin_state_entries WHERE namespace = 'upgrade-sentinel'")
          .all(),
      };
    });
  const before = inspect();
  await closeOpenClawStateDatabaseAsync();
  const loaded = await readStoredClaw();
  expect(loaded).toEqual(record);
  expect(inspect()).toEqual(before);
  const [accountId, request] = Object.entries(requests!)[0]!;
  await writeStoredClaw({ ...loaded!, member_browser_requests: { [accountId]: request } });
  await closeOpenClawStateDatabaseAsync();
  expect(await readStoredClaw()).toEqual({
    ...record,
    member_browser_requests: { [accountId]: request },
  });
  expect(inspect()).toEqual(before);
  const rows = new Map((await store.entries()).map(({ key, value }) => [key, value]));
  for (const [key, value] of Object.entries(priorRows)) {
    expect(rows.get(key)).toEqual(value);
  }
  expect(rows.get("member-browser-requests:0")).toEqual({ [accountId]: request });
});

it("moves prior rows without losing bindings and refuses an incomplete partitioned record", async ({
  state,
}) => {
  state.applyEnv();
  // A small monolithic predecessor fits the old value cap and represents an existing installation.
  const record = {
    ...fullClaw(),
    authority: null,
    invite_reports: {},
    member_browser_requests: {},
    token_bindings: [],
  };
  const store = createCorePluginStateKeyedStore<unknown>({
    ownerId: "core:openclaw-id",
    namespace: "claw",
    retention: "retained",
  });
  await store.register("current", record);
  const binding = { device_id: "browser", role: "operator", peer_key: "iroh:a", bound_at: 1 };
  await store.register("token-bindings", { v: 1, bindings: [binding] });
  const loaded = await readStoredClaw();
  expect(loaded?.token_bindings).toEqual([binding]);
  await writeStoredClaw(loaded!);
  await closeOpenClawStateDatabaseAsync();
  expect(await readStoredClaw()).toMatchObject({ ...record, token_bindings: [binding] });
  await store.delete("token-bindings");
  await expect(readStoredClaw()).rejects.toThrow("missing token-bindings");
});

it("settles a durably committed removal after its write acknowledgement is lost", async ({
  state,
}) => {
  state.applyEnv();
  const claw = await linkedClaw({ read: readStoredClaw, write: writeStoredClaw });
  const { service, effects } = serviceFor(claw.authority);
  // Use a distinct member peer, not the owner's endpoint, so admission checks test removal.
  const memberKey = formatIrohEndpointKey(new Uint8Array(32).fill(42));
  expect(
    await claw.authority.submit(
      await claw.sign({
        op: "add",
        account_id: "member",
        role: "operator",
        peer_keys: [memberKey],
        invite_id: null,
      }),
      "tunnel",
    ),
  ).toMatchObject({ ok: true });
  const removal = await claw.sign({ op: "remove", account_id: "member" });
  const dispatch = sqliteWorkerOwnerProbe.command(stateWriter, async (command, args, scope) => {
    const result = await scope.execute(command, args);
    if (command.type === "pluginState.replace") {
      throw new Error("acknowledgement lost");
    }
    return result;
  });
  try {
    expect(await service.submitStatement("tunnel", removal)).toMatchObject({
      ok: true,
      removal: { connectionsClosed: 1 },
    });
    expect(effects.closeConnections).toHaveBeenCalledOnce();
  } finally {
    dispatch.mockRestore();
  }
  expect(await claw.authority.resolvePeer(memberKey)).toBeUndefined();
  expect((await readStoredClaw())?.authority?.members).not.toHaveProperty("member");
  await claw.authority.recordDiscovery({ mailbox_cursor: "after-removal" });
  expect((await readStoredClaw())?.authority?.members).not.toHaveProperty("member");
});

it("restores approved invite replays after reopening and keeps pre-upgrade consumed invites refused", async ({
  state,
}) => {
  state.applyEnv();
  const claw = await linkedClaw({ read: readStoredClaw, write: writeStoredClaw });
  const approve = async (email: string, accountId: string) => {
    const invite = await ownerInvite(claw, { email });
    expect(
      await claw.authority.registerInvite({ cap: invite.cap, proofKey: invite.proofKey }, "tunnel"),
    ).toMatchObject({ ok: true });
    const mail = await redemptionMail({
      clawId: claw.clawId,
      inviteId: invite.inviteId,
      proofKey: invite.proofKey,
      accountId,
      email,
    });
    expect(
      await applyMailboxMessage(mail.message, {
        submit: (statement) => claw.authority.submit(statement, "mailbox"),
        redeem: (redemption, sender) => claw.authority.redeem(redemption, sender),
        redeemNode: (redemption) => claw.authority.redeemNode(redemption),
      }),
    ).toMatchObject([{ ok: true, status: "pending" }]);
    expect(
      await claw.authority.submit(
        await claw.sign({
          op: "add",
          account_id: accountId,
          role: "operator",
          peer_keys: [mail.peerKey],
          invite_id: invite.inviteId,
        }),
        "tunnel",
      ),
    ).toMatchObject({ ok: true });
    return { inviteId: invite.inviteId, mail };
  };
  const current = await approve("bob@example.test", "acct-bob");
  const legacy = await approve("carol@example.test", "acct-carol");
  // A consumed invite stored before approval identities were retained has no approved field.
  const stored = (await readStoredClaw())!;
  const { approved: _dropped, ...legacyInvite } = stored.authority!.invites[legacy.inviteId]!;
  await writeStoredClaw({
    ...stored,
    authority: {
      ...stored.authority!,
      invites: { ...stored.authority!.invites, [legacy.inviteId]: legacyInvite },
    },
  });
  await closeOpenClawStateDatabaseAsync();

  const reopened = (await readStoredClaw())!;
  expect(reopened.authority!.invites[current.inviteId]).toMatchObject({
    status: "consumed",
    approved: { account_id: "acct-bob", peer_key: current.mail.peerKey },
  });
  expect(reopened.authority!.invites[legacy.inviteId]).not.toHaveProperty("approved");
  const authority = createOpenClawIdAuthority();
  await authority.load();
  const before = authority.current();
  const sink = {
    submit: (statement: unknown) => authority.submit(statement, "mailbox"),
    redeem: (redemption: unknown, sender: Parameters<typeof authority.redeem>[1]) =>
      authority.redeem(redemption, sender),
    redeemNode: (redemption: unknown) => authority.redeemNode(redemption),
  };
  expect(await applyMailboxMessage(current.mail.message, sink)).toMatchObject([{ ok: true }]);
  expect(await applyMailboxMessage(legacy.mail.message, sink)).toMatchObject([
    { ok: false, code: "invite_used" },
  ]);
  expect(authority.current()).toBe(before);
  expect(await authority.resolvePeer(current.mail.peerKey)).toBeDefined();
  expect(await authority.resolvePeer(legacy.mail.peerKey)).toBeDefined();
  expect(await readStoredClaw()).toEqual(reopened);
});

for (const end of ["disable", "stop"] as const) {
  it(`refuses a verified rebind held at real storage admission after ${end}`, async ({ state }) => {
    state.applyEnv();
    const claw = await linkedClaw({ read: readStoredClaw, write: writeStoredClaw });
    const directory = path.join(claw.stateDir, "openclaw-id");
    const endpointFile = path.join(directory, "endpoint.key");
    const { key: endpoint } = await loadOrCreateEndpointKey(endpointFile);
    const record = (await readStoredClaw())!;
    // Bootstrap a signed fixture whose two active key files match its binding.
    await writeStoredClaw({
      ...record,
      binding: await signStatement(
        "ServerBinding",
        {
          ...record.binding!.body,
          k_srv: formatIrohEndpointKey(Buffer.from(ed25519PublicKeyHex(endpoint), "hex")),
        },
        claw.root,
      ),
    });
    const authority = createOpenClawIdAuthority();
    await authority.load();
    await authority.recordDiscovery({ owner_account_id: "owner", published_binding_seq: 1 });
    const config = { enabled: true };
    const { service } = serviceFor(authority, config, claw.stateDir);
    const before = await readStoredClaw();
    const activeKeys = () =>
      ["gateway.key", "endpoint.key"].map((file) => fs.readFileSync(path.join(directory, file)));
    const beforeKeys = activeKeys();
    const nextEndpoint = formatIrohEndpointKey(
      Buffer.from(
        ed25519PublicKeyHex((await loadOrCreateEndpointKey(`${endpointFile}.next`)).key),
        "hex",
      ),
    );
    vi.spyOn(tunnelRuntime, "stageEndpointKey").mockResolvedValue(nextEndpoint);
    const binding = await signStatement(
      "ServerBinding",
      {
        ...before!.binding!.body,
        k_gw: await stageGatewayKey(claw.stateDir),
        k_srv: nextEndpoint,
        binding_seq: 2,
      },
      claw.root,
    );
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    let verified = false;
    vi.spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
      const valid = await verify(...args);
      verified ||= valid;
      return valid;
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const dispatch = sqliteWorkerOwnerProbe.command(stateWriter, async (command, args, scope) => {
      if (command.type === "pluginState.replace") {
        entered.resolve();
        await release.promise;
      }
      return scope.execute(command, args);
    });
    const pending = service.rebind("commit", "local_operator", { binding });
    try {
      await entered.promise;
      expect(verified).toBe(true);
      if (end === "stop") {
        await service.stop();
      } else {
        config.enabled = false;
      }
      release.resolve();
      const result = await pending;
      expect(await readStoredClaw()).toEqual(before);
      expect(authority.current()).toEqual(before);
      expect(activeKeys()).toEqual(beforeKeys);
      expect(result).toMatchObject({ ok: false, code: "rebind_cancelled" });
    } finally {
      release.resolve();
      await pending.catch(() => {});
      dispatch.mockRestore();
      await service.stop();
    }
  });
}
