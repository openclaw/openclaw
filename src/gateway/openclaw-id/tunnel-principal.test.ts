import { afterEach, describe, expect, it } from "vitest";
import {
  formatIrohEndpointKey,
  randomBytes,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { authorizeWsControlUiGatewayConnect, authorizeHttpGatewayConnect } from "../auth.js";
import type { GatewayIngressAttribution } from "../ingress-attribution.js";
import { createOpenClawIdAuthority } from "./authority.js";
import { linkedClaw } from "./openclaw-id.test-support.js";
import {
  isOpenClawIdTunnelPrincipalCurrent,
  openClawIdRecoveryPrincipalSchema,
  prepareOpenClawIdTunnelPrincipal,
  resolveOpenClawIdTunnelPrincipal,
  setOpenClawIdTunnelPrincipalLookup,
  openclawIdTunnelRolePolicy,
  openclawIdTunnelUser,
  setOpenClawIdTunnelPrincipalResolver,
} from "./tunnel-principal.js";

afterEach(() => {
  setOpenClawIdTunnelPrincipalResolver(undefined);
  setOpenClawIdTunnelPrincipalLookup(undefined);
});

function tunnelAttribution(peerKey: string): GatewayIngressAttribution {
  return {
    kind: "openclaw-id-tunnel",
    peerKey,
    clientIp: "fd7a:115c:a1e0::1",
    rateLimit: { subject: { key: `openclaw-id:${peerKey}` }, resetOnSuccess: true },
  };
}

describe("OpenClaw ID tunnel principals", () => {
  it("resolves owner devices, members with their role, and nothing else", async () => {
    const claw = await linkedClaw();
    const op = formatIrohEndpointKey(randomBytes(32));
    const viewer = formatIrohEndpointKey(randomBytes(32));
    for (const [account, role, key] of [
      ["acct-op", "operator", op],
      ["acct-view", "viewer", viewer],
    ] as const) {
      const add = await claw.sign({
        op: "add",
        account_id: account,
        role,
        peer_keys: [key],
        invite_id: null,
      });
      expect(await claw.authority.submit(add, "tunnel")).toMatchObject({ ok: true });
    }
    expect(await claw.authority.resolvePeer(claw.w1)).toMatchObject({
      kind: "owner",
      peerKey: claw.w1,
    });
    expect(await claw.authority.resolvePeer(op)).toMatchObject({
      kind: "member",
      peerKey: op,
      accountId: "acct-op",
      role: "operator",
    });
    expect(await claw.authority.resolvePeer(viewer)).toMatchObject({ role: "viewer" });

    // A role change reconnects the member so the new ceiling applies at once.
    const change = await claw.sign({ op: "set_role", account_id: "acct-view", role: "operator" });
    expect(await claw.authority.submit(change, "tunnel")).toMatchObject({
      ok: true,
      events: expect.arrayContaining([{ type: "disconnect", peer_keys: [viewer] }]),
    });
    expect(await claw.authority.resolvePeer(viewer)).toMatchObject({ role: "operator" });
    expect(
      await claw.authority.resolvePeer(formatIrohEndpointKey(randomBytes(32))),
    ).toBeUndefined();
    expect(await claw.authority.resolvePeer("not-a-key")).toBeUndefined();

    const remove = await claw.sign({ op: "remove", account_id: "acct-op" });
    expect(await claw.authority.submit(remove, "tunnel")).toMatchObject({ ok: true });
    expect(await claw.authority.resolvePeer(op)).toBeUndefined();
  });

  it("caps members by role and leaves owners uncapped", () => {
    const owner = { kind: "owner" as const, peerKey: "iroh:a" };
    const operator = {
      kind: "member" as const,
      peerKey: "iroh:b",
      accountId: "acct-op",
      role: "operator" as const,
    };
    const viewer = { ...operator, role: "viewer" as const };
    expect(openclawIdTunnelRolePolicy(owner)).toBeUndefined();
    expect(openclawIdTunnelUser(owner)).toBeUndefined();
    expect(openclawIdTunnelUser(operator)).toBe("openclaw-id:acct-op");
    expect(openclawIdTunnelRolePolicy(operator)?.scopes).toEqual(
      expect.arrayContaining(["operator.read", "operator.write"]),
    );
    expect(openclawIdTunnelRolePolicy(operator)?.scopes).not.toContain("operator.admin");
    expect(openclawIdTunnelRolePolicy(operator)?.scopes).not.toContain("operator.pairing");
    expect(openclawIdTunnelRolePolicy(viewer)?.scopes).toEqual(["operator.read"]);
  });

  it("denies unknown member roles at connect, HTTP and retained/recovery admission", async () => {
    const principal = {
      kind: "member" as const,
      peerKey: `iroh:${"ab".repeat(32)}`,
      accountId: "acct-guest",
      role: "guest",
      authority: { clawId: "claw", rootPub: "root", listedSeq: 1 },
    };
    setOpenClawIdTunnelPrincipalResolver(async () => principal);
    setOpenClawIdTunnelPrincipalLookup(() => principal);
    expect(openclawIdTunnelRolePolicy(principal)).toEqual({
      scopes: [],
      agents: [],
      sessions: { others: "none" },
    });
    expect(await resolveOpenClawIdTunnelPrincipal(principal.peerKey)).toBeUndefined();
    for (const authorize of [authorizeWsControlUiGatewayConnect, authorizeHttpGatewayConnect]) {
      expect(
        await authorize({
          auth: { mode: "token", token: "secret", allowTailscale: false },
          connectAuth: { token: "secret" },
          ingressAttribution: tunnelAttribution(principal.peerKey),
        }),
      ).toEqual({ ok: false, reason: "openclaw_id_not_admitted" });
    }
    expect(isOpenClawIdTunnelPrincipalCurrent(principal)).toBe(false);
    await expect(prepareOpenClawIdTunnelPrincipal(principal)).rejects.toThrow(
      "membership authority changed",
    );
  });

  it("retains valid opaque role names in recovery records without admitting them", async () => {
    const principal = {
      kind: "member",
      peerKey: `iroh:${"ab".repeat(32)}`,
      accountId: "acct-guest",
      role: "guest",
      authority: { clawId: "claw", rootPub: "root", listedSeq: 1 },
    };
    expect(openClawIdRecoveryPrincipalSchema.parse(principal)).toEqual(principal);
    for (const role of ["", "Guest", "2guest", "a".repeat(65), "guest\n"]) {
      expect(openClawIdRecoveryPrincipalSchema.safeParse({ ...principal, role }).success).toBe(
        false,
      );
    }
    const claw = await linkedClaw();
    const peer = formatIrohEndpointKey(randomBytes(32));
    expect(
      await claw.authority.submit(
        await claw.sign({
          op: "add",
          account_id: "acct-guest",
          role: "guest",
          peer_keys: [peer],
          invite_id: null,
        }),
        "tunnel",
      ),
    ).toMatchObject({ ok: true });
    const reloaded = createOpenClawIdAuthority(claw.store);
    await reloaded.load();
    setOpenClawIdTunnelPrincipalResolver((key) => reloaded.resolvePeer(key));
    setOpenClawIdTunnelPrincipalLookup((key) => reloaded.currentPeer(key));
    expect(reloaded.currentPeer(peer)).toMatchObject({ kind: "member", role: "guest" });
    expect(await resolveOpenClawIdTunnelPrincipal(peer)).toBeUndefined();
    const stored = openClawIdRecoveryPrincipalSchema.parse(reloaded.currentPeer(peer));
    expect(isOpenClawIdTunnelPrincipalCurrent(stored)).toBe(false);
    await expect(prepareOpenClawIdTunnelPrincipal(stored)).rejects.toThrow(
      "membership authority changed",
    );
  });

  it("authenticates admitted tunnel peers as trusted-proxy principals in token mode", async () => {
    const auth = { mode: "token" as const, token: "secret", allowTailscale: false };
    const owner = `iroh:${"1a".repeat(32)}`;
    const member = `iroh:${"1b".repeat(32)}`;
    // A tunnel whose authority is unavailable must not fall through to another door.
    expect(
      await authorizeHttpGatewayConnect({ auth, ingressAttribution: tunnelAttribution(owner) }),
    ).toMatchObject({ ok: false, reason: "openclaw_id_not_admitted" });

    setOpenClawIdTunnelPrincipalResolver(async (peerKey) =>
      peerKey === owner
        ? { kind: "owner", peerKey }
        : peerKey === member
          ? { kind: "member", peerKey, accountId: "acct-m", role: "viewer" }
          : undefined,
    );
    expect(
      await authorizeHttpGatewayConnect({ auth, ingressAttribution: tunnelAttribution(owner) }),
    ).toEqual({ ok: true, method: "trusted-proxy", openclawId: { kind: "owner", peerKey: owner } });
    expect(
      await authorizeHttpGatewayConnect({ auth, ingressAttribution: tunnelAttribution(member) }),
    ).toMatchObject({ ok: true, method: "trusted-proxy", user: "openclaw-id:acct-m" });
    expect(
      await authorizeHttpGatewayConnect({
        auth,
        connectAuth: { token: "secret" },
        ingressAttribution: tunnelAttribution(`iroh:${"1c".repeat(32)}`),
      }),
    ).toEqual({ ok: false, reason: "openclaw_id_not_admitted" });
    // Loopback token auth is untouched by the resolver.
    expect(
      await authorizeHttpGatewayConnect({
        auth,
        connectAuth: { token: "secret" },
        ingressAttribution: {
          kind: "direct-local",
          clientIp: "127.0.0.1",
          rateLimit: { subject: { key: "127.0.0.1" }, resetOnSuccess: true },
        },
      }),
    ).toEqual({ ok: true, method: "token" });
  });
});

it("retains the original signed listing across authority reload, not a later approval of the same peer", async () => {
  const claw = await linkedClaw();
  const peer = formatIrohEndpointKey(randomBytes(32));
  const add = () =>
    claw.sign({
      op: "add",
      account_id: "acct-durable",
      role: "operator",
      peer_keys: [peer],
      invite_id: null,
    });
  expect(await claw.authority.submit(await add(), "tunnel")).toMatchObject({ ok: true });
  const admitted = openClawIdRecoveryPrincipalSchema.parse(await claw.authority.resolvePeer(peer));
  const owner = openClawIdRecoveryPrincipalSchema.parse(await claw.authority.resolvePeer(claw.w1));
  const reloaded = createOpenClawIdAuthority(claw.store);
  await reloaded.load();
  setOpenClawIdTunnelPrincipalLookup((key) => reloaded.currentPeer(key));
  const serialized = JSON.stringify(admitted);
  expect(isOpenClawIdTunnelPrincipalCurrent(JSON.parse(serialized))).toBe(true);
  expect(isOpenClawIdTunnelPrincipalCurrent(owner)).toBe(true);
  const remove = await claw.sign({ op: "remove", account_id: "acct-durable" });
  expect(await claw.authority.submit(remove, "tunnel")).toMatchObject({ ok: true });
  expect(await claw.authority.submit(await add(), "tunnel")).toMatchObject({ ok: true });
  setOpenClawIdTunnelPrincipalLookup((key) => claw.authority.currentPeer(key));
  expect(isOpenClawIdTunnelPrincipalCurrent(admitted)).toBe(false);
  expect(isOpenClawIdTunnelPrincipalCurrent(owner)).toBe(true);
});
