import { afterEach, expect, it, vi } from "vitest";
import { createOpenClawIdAuthority } from "./authority.js";
import { linkedClaw, nowSeconds } from "./openclaw-id.test-support.js";
import { createTunnelPrincipalPublisher } from "./service-tunnel-principals.js";
import {
  isOpenClawIdTunnelPrincipalCurrent,
  isSameOpenClawIdTunnelPrincipal,
  openClawIdRecoveryPrincipalSchema,
  openclawIdTunnelRolePolicy,
  openclawIdTunnelUser,
  recordOpenClawIdTunnelActivity,
} from "./tunnel-principal.js";

afterEach(() => vi.restoreAllMocks());

it("resolves a node separately, refreshes authenticated activity, and invalidates its original listing", async () => {
  const claw = await linkedClaw();
  const peerKey = `iroh:${"a7".repeat(32)}` as const;
  const record = claw.authority.current()!;
  const state = record.authority!;
  const seen = nowSeconds();
  await claw.store.write({
    ...record,
    authority: {
      ...state,
      nodes: {
        [peerKey]: {
          label: "node",
          listed_seq: state.seq,
          added_by: "root",
          last_seen: seen,
          invite_id: "c1".repeat(16),
          description: {
            display_name: "node",
            platform: "linux",
            commands: ["system.run"],
            caps: [],
          },
        },
      },
    },
  });
  const authority = createOpenClawIdAuthority(claw.store);
  await authority.load();
  const publisher = createTunnelPrincipalPublisher({
    authority: async () => authority,
    current: () => authority,
    enabled: () => true,
    warn: () => {},
  });
  publisher.publish();
  try {
    const principal = openClawIdRecoveryPrincipalSchema.parse(await authority.resolvePeer(peerKey));
    expect(principal.kind).toBe("node");
    expect(openclawIdTunnelUser(principal)).toBeUndefined();
    expect(openclawIdTunnelRolePolicy(principal)?.scopes).toEqual([]);
    expect((await authority.admittedPeerKeys()).admitted).toContain(peerKey);
    expect(isOpenClawIdTunnelPrincipalCurrent(principal)).toBe(true);
    vi.spyOn(Date, "now").mockReturnValue((seen + 3601) * 1000);
    const changed = new Promise<void>((resolve) => {
      const stop = authority.onPeopleChanged(() => {
        stop();
        resolve();
      });
    });
    recordOpenClawIdTunnelActivity(principal);
    await changed;
    expect(authority.current()?.authority?.nodes[peerKey]?.last_seen).toBe(seen + 3601);
    const remove = await claw.sign({ op: "remove_node", peer_key: peerKey });
    expect(await authority.submit(remove, "tunnel")).toMatchObject({
      ok: true,
      events: expect.arrayContaining([{ type: "remove_node_pairings", peer_keys: [peerKey] }]),
    });
    expect(isOpenClawIdTunnelPrincipalCurrent(principal)).toBe(false);
    recordOpenClawIdTunnelActivity(principal);
    expect(authority.current()?.authority?.nodes[peerKey]).toBeUndefined();
  } finally {
    publisher.stop();
  }
});

it("matches a retained node principal only under the same listing", () => {
  const authority = { clawId: "claw", rootPub: "root", listedSeq: 4 };
  const node = { kind: "node" as const, peerKey: `iroh:${"a8".repeat(32)}`, authority };
  expect(isSameOpenClawIdTunnelPrincipal(node, { ...node, authority: { ...authority } })).toBe(
    true,
  );
  expect(
    isSameOpenClawIdTunnelPrincipal(node, { ...node, authority: { ...authority, listedSeq: 5 } }),
  ).toBe(false);
  expect(isSameOpenClawIdTunnelPrincipal(node, { ...node, kind: "owner" })).toBe(false);
});
