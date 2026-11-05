// A claw at every protocol cap, with every text field at its longest, still saves: the claw
// record and its token-bindings row each stay within the plugin-state value limit.
import { describe, expect, it, vi } from "vitest";
import {
  MAX_INVITES,
  MAX_MEMBER_PEER_KEYS,
  MAX_MEMBERS,
  MAX_OWNER_DEVICE_PEER_KEYS,
  MAX_OWNER_DEVICES,
  OWNER_CAPABILITIES,
  type AuthorityState,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { MAX_PLUGIN_STATE_VALUE_BYTES } from "../../plugin-state/plugin-state-store.kernel.js";
import { serializePluginStoreJson } from "../../plugin-state/plugin-store-validation.js";
import { clawStoreRows, readStoredClaw, writeStoredClaw, type StoredClaw } from "./claw-store.js";

// The claw namespace's rows, held in memory in place of the plugin-state store.
const storedRows = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../../plugin-state/plugin-state-store.js", () => ({
  createCorePluginStateKeyedStore: () => ({
    lookup: async (key: string) => storedRows.get(key),
    register: async (key: string, value: unknown) =>
      void storedRows.set(key, structuredClone(value)),
  }),
}));

const TEXT = "x".repeat(256);
const NOW = 1_800_000_000;
const SEQ = 1_000_000;
const hex = (n: number) => n.toString(16).padStart(64, "0");
const ed = (n: number) => `ed25519:${hex(n)}` as const;
const iroh = (n: number) => `iroh:${hex(n)}` as const;
const fp = (n: number) => `fp:${hex(n)}` as const;
const id = (n: number) => n.toString(16).padStart(32, "0");
const sig = "A".repeat(86);
const caps = [...OWNER_CAPABILITIES];

// The largest claw the protocol caps allow, with a token binding for every peer key.
function fullClaw(): StoredClaw {
  const authority: AuthorityState = {
    claw_id: id(1),
    anchor: { root_pub: ed(1) },
    seq: SEQ,
    owner_devices: {},
    members: {},
    invites: {},
  };
  const peers: string[] = [];
  for (let d = 0; d < MAX_OWNER_DEVICES; d += 1) {
    const keys = Array.from({ length: MAX_OWNER_DEVICE_PEER_KEYS }, (_, k) => iroh(d * 100 + k));
    peers.push(...keys);
    const body = { device_pub: ed(d), peer_keys: keys, label: TEXT, scope: "owner" as const };
    authority.owner_devices[fp(d)] = {
      cert: {
        v: 1,
        type: "OwnerDeviceCert",
        signer: ed(0),
        alg: "ed25519",
        sig,
        body: { ...body, caps, issued_at: NOW, expires_at: NOW, root_epoch: 1 },
      },
      caps,
      approved_by: fp(0),
      last_seen: NOW,
      listed_seq: SEQ,
      peer_listed_seq: keys.map(() => SEQ),
    };
  }
  for (let m = 0; m < MAX_MEMBERS; m += 1) {
    const keys = Array.from({ length: MAX_MEMBER_PEER_KEYS }, (_, k) => iroh(1e6 + m * 100 + k));
    peers.push(...keys);
    authority.members[`${TEXT.slice(4)}${m.toString().padStart(4, "0")}`] = {
      role: "operator",
      peer_keys: keys,
      listed_seq: keys.map(() => SEQ),
      last_seen: Object.fromEntries(keys.map((key) => [key, NOW])),
    };
  }
  const reports: NonNullable<StoredClaw["invite_reports"]> = {};
  for (let i = 0; i < MAX_INVITES; i += 1) {
    authority.invites[id(i)] = {
      cap: {
        claw_id: id(1),
        invite_id: id(i),
        role: "operator",
        label: TEXT,
        audience: { kind: "email", value: TEXT },
        created_at: NOW,
        expires_at: NOW,
        single_use: true,
        secret_hash: hex(i),
      },
      status: "pending",
      proof_key: hex(i),
      created_by: fp(0),
      pending: { account_id: TEXT, device_pub: ed(i), peer_key: iroh(i), requested_at: NOW },
    };
    reports[id(i)] = {
      account_id: TEXT,
      email: TEXT,
      display_name: TEXT,
      location_hint: TEXT,
      resolution: "approved",
      resolved_at: NOW,
    };
  }
  const bindingBody = { claw_id: id(1), hostname: TEXT, k_srv: iroh(0), k_gw: ed(0) };
  return {
    v: 1,
    claw_id: id(1),
    hostname: TEXT,
    authority,
    invite_reports: reports,
    owner_profile: { sub: TEXT, email: TEXT, name: TEXT },
    binding: {
      v: 1,
      type: "ServerBinding",
      signer: ed(1),
      alg: "ed25519",
      sig,
      body: { ...bindingBody, binding_seq: SEQ, root_epoch: 1, issued_at: NOW },
    },
    token_bindings: peers.map((peer, n) => {
      return { device_id: hex(n), role: "operator", peer_key: peer, bound_at: NOW };
    }),
    discovery: {
      owner_account_id: TEXT,
      published_binding_seq: SEQ,
      published_snapshot_seq: SEQ,
      publish_pending: true,
      published_snapshot_at: NOW,
      mailbox_cursor: TEXT,
    },
  };
}

// Serializes a row as the plugin-state store does, throwing past the value limit.
function storedBytes(value: unknown): number {
  const fail = (message: string) => new Error(message);
  const errors = { invalid: fail, limit: fail };
  const json = serializePluginStoreJson({
    value,
    label: "claw row",
    errors,
    maxBytes: MAX_PLUGIN_STATE_VALUE_BYTES,
  });
  return Buffer.byteLength(json);
}

describe("claw record size", () => {
  it("keeps the record and its token-bindings row within the value limit at every cap", () => {
    const rows = clawStoreRows(fullClaw());
    expect(storedBytes(rows.claw)).toBeLessThan(MAX_PLUGIN_STATE_VALUE_BYTES);
    expect(storedBytes(rows.tokenBindings)).toBeLessThan(MAX_PLUGIN_STATE_VALUE_BYTES);
    expect(() => storedBytes(fullClaw())).toThrow();
  });
});

describe("claw record rows", () => {
  const binding = { device_id: "browser-a", role: "operator", peer_key: "iroh:a", bound_at: NOW };
  const claw = (): StoredClaw => {
    const discovery = { owner_account_id: null, published_binding_seq: 0, mailbox_cursor: null };
    const base = { v: 1 as const, claw_id: id(1), hostname: null, authority: null, binding: null };
    return { ...base, discovery: { ...discovery, published_snapshot_seq: 0 } };
  };

  it("stores token bindings in their own row and reads them back with the record", async () => {
    storedRows.clear();
    await writeStoredClaw({ ...claw(), token_bindings: [binding] });
    expect(storedRows.get("current")).not.toHaveProperty("token_bindings");
    expect(storedRows.get("token-bindings")).toEqual({ v: 1, bindings: [binding] });
    expect((await readStoredClaw())?.token_bindings).toEqual([binding]);
  });

  it("keeps bindings saved inside an older record until the next write moves them out", async () => {
    storedRows.clear();
    storedRows.set("current", { ...claw(), token_bindings: [binding] });
    expect((await readStoredClaw())?.token_bindings).toEqual([binding]);
    storedRows.set("token-bindings", { v: 1, bindings: [] });
    expect((await readStoredClaw())?.token_bindings).toEqual([]);
  });
});
