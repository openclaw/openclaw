import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, vi } from "vitest";
// Real shared-state worker proof: bounded sections, restart recovery and one-transaction rollback.
import {
  formatIrohEndpointKey,
  signStatement,
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
import { linkedClaw, serviceFor } from "./openclaw-id.test-support.js";
import { createKeyFile, ed25519PublicKeyHex } from "./tunnel-child/keyfile.js";
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

it("moves prior rows without losing bindings and refuses an incomplete partitioned record", async ({
  state,
}) => {
  state.applyEnv();
  // A small monolithic predecessor fits the old value cap and represents an existing installation.
  const record = { ...fullClaw(), authority: null, invite_reports: {}, token_bindings: [] };
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

for (const end of ["disable", "stop"] as const) {
  it(`refuses a verified rebind held at real storage admission after ${end}`, async ({ state }) => {
    state.applyEnv();
    const claw = await linkedClaw({ read: readStoredClaw, write: writeStoredClaw });
    const directory = path.join(claw.stateDir, "openclaw-id");
    const endpointFile = path.join(directory, "endpoint.key");
    const endpoint = createKeyFile(endpointFile);
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
      Buffer.from(ed25519PublicKeyHex(createKeyFile(`${endpointFile}.next`)), "hex"),
    );
    vi.spyOn(tunnelRuntime, "stageEndpointKey").mockResolvedValue(nextEndpoint);
    const binding = await signStatement(
      "ServerBinding",
      {
        ...before!.binding!.body,
        k_gw: stageGatewayKey(claw.stateDir),
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
