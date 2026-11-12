import { randomUUID } from "node:crypto";
// End-to-end mapping of admitted OpenClaw ID tunnel devices onto Gateway auth
// (OCF-225), against a token-mode Gateway. Relayed requests are marked the way
// the private ingress listener marks them; a test-only header selects the peer.
import { EventEmitter } from "node:events";
import http, { type IncomingMessage } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { writeConfigFile } from "../config/config.js";
import { issueDeviceBootstrapToken } from "../infra/device-bootstrap.js";
import { revokeDeviceToken } from "../infra/device-pairing-tokens.js";
import {
  getPairedDevice,
  listDevicePairing,
  rejectDevicePairing,
  removePairedDevice,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { createDeferredCore } from "../shared/deferred.js";
import { CONTROL_UI_OWNER_BOOTSTRAP_PROFILE } from "../shared/device-bootstrap-profile.js";
import {
  ensureCanonicalUserProfileForOpenClawIdIdentity,
  linkCanonicalOpenClawIdUserProfile,
  unlinkCanonicalOpenClawIdUserProfile,
} from "../state/user-profile-openclaw-id.js";
import * as profileWrites from "../state/user-profile-writes.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { setDeviceTokenBindingOwner } from "./openclaw-id/device-token-binding.js";
import { setOpenClawIdOwnerAccountResolver } from "./openclaw-id/owner-account.js";
import {
  setOpenClawIdTunnelPrincipalResolver,
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import { useAuthIdentityFixture } from "./server.auth.identity-fixture.test-support.js";
import { BROWSER_ORIGIN, CONTROL_UI_CLIENT, openWs } from "./server.auth.test-helpers.js";
import {
  connectReq,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

// Records SSH verification probes instead of running them; a tunnel address names no host.
const sshProbe = vi.hoisted(() => vi.fn(async () => ({ status: "timeout" as const })));
vi.mock("./node-pairing-ssh-verify.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./node-pairing-ssh-verify.runtime.js")>()),
  runNodeIdentityProbe: sshProbe,
}));

const makeIdentityPath = useAuthIdentityFixture();
const TOKEN = "tunnel-suite-secret";
const TEST_PEER_HEADER = "x-test-openclaw-id-peer";
const OWNER_KEY = `iroh:${"0a".repeat(32)}`;
const OPERATOR_KEY = `iroh:${"0b".repeat(32)}`;
const VIEWER_KEY = `iroh:${"0c".repeat(32)}`;
const REMOVED_KEY = `iroh:${"0d".repeat(32)}`;
const CONTROL_UI_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
  "operator.questions",
];
const PRINCIPALS: Record<string, OpenClawIdTunnelPrincipal> = {
  [OWNER_KEY]: { kind: "owner", peerKey: OWNER_KEY },
  [OPERATOR_KEY]: { kind: "member", peerKey: OPERATOR_KEY, accountId: "acct_op", role: "operator" },
  [VIEWER_KEY]: { kind: "member", peerKey: VIEWER_KEY, accountId: "acct_view", role: "viewer" },
};

let started: Awaited<ReturnType<typeof createGatewaySuiteHarness>> | undefined;

// Stands in for the ingress listener: marks the request relayed from the peer
// named by the test header before the Gateway's listener sees it.
function markTunnelRequests(this: http.Server, event: string | symbol, ...args: unknown[]) {
  if (event === "upgrade" || event === "request") {
    const req = args[0] as IncomingMessage;
    const peerKey = req.headers?.[TEST_PEER_HEADER];
    if (typeof peerKey === "string") {
      delete req.headers[TEST_PEER_HEADER];
      markGatewayIngressTransport(req, {
        kind: "openclaw-id-tunnel",
        peerKey,
        clientIp: "fd7a:115c:a1e0::1",
      });
    }
  }
  return EventEmitter.prototype.emit.call(this, event, ...args);
}

beforeAll(async () => {
  vi.spyOn(http.Server.prototype, "emit").mockImplementation(markTunnelRequests);
  testState.gatewayAuth = undefined;
  await writeConfigFile({
    gateway: {
      auth: { mode: "token", token: TOKEN },
      controlUi: { allowedOrigins: [BROWSER_ORIGIN] },
    },
  });
  started = await createGatewaySuiteHarness();
  setOpenClawIdTunnelPrincipalResolver(async (peerKey) => PRINCIPALS[peerKey]);
  setOpenClawIdTunnelPrincipalLookup((peerKey) => PRINCIPALS[peerKey]);
  // The service publishes its binding writer before the tunnel admits a device.
  const bindings = new Map<string, string>();
  setDeviceTokenBindingOwner({
    lookup: (deviceId, role) => bindings.get(`${deviceId}:${role}`),
    record: async (deviceId, role, peerKey) => {
      bindings.set(`${deviceId}:${role}`, peerKey);
    },
    forget: async (tokens) => {
      for (const token of tokens) {
        bindings.delete(`${token.deviceId}:${token.role}`);
      }
    },
    reportMismatch: () => {},
  });
});

afterAll(async () => {
  setDeviceTokenBindingOwner(undefined);
  setOpenClawIdTunnelPrincipalResolver(undefined);
  setOpenClawIdTunnelPrincipalLookup(undefined);
  await started?.close();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  const pairing = await listDevicePairing();
  for (const pending of pairing.pending) {
    await rejectDevicePairing(pending.requestId);
  }
  for (const paired of pairing.paired) {
    await removePairedDevice(paired.deviceId);
  }
});

async function connectTunnel(
  peerKey: string | undefined,
  options: {
    token?: string;
    bootstrapToken?: string;
    identityPath?: string;
    scopes?: string[];
  } = {},
) {
  const ws: WebSocket = await openWs(started!.port, {
    origin: BROWSER_ORIGIN,
    ...(peerKey ? { [TEST_PEER_HEADER]: peerKey } : {}),
  });
  const res = await connectReq(ws, {
    client: CONTROL_UI_CLIENT,
    scopes: options.scopes ?? CONTROL_UI_SCOPES,
    deviceIdentityPath:
      options.identityPath ?? makeIdentityPath(`openclaw-tunnel-${randomUUID()}.sqlite`),
    ...(options.token ? { token: options.token } : { skipDefaultAuth: true }),
    ...(options.bootstrapToken ? { bootstrapToken: options.bootstrapToken } : {}),
    browserOrigin: BROWSER_ORIGIN,
  });
  return { ws, res };
}

type HelloAuth = {
  method?: string;
  scopes?: string[];
  roleAllowsAdmin?: boolean;
  deviceToken?: string;
};

function helloAuth(res: Awaited<ReturnType<typeof connectReq>>): HelloAuth | undefined {
  return (res.payload as { auth?: HelloAuth } | undefined)?.auth;
}

function grantedScopes(res: Awaited<ReturnType<typeof connectReq>>): string[] {
  return (helloAuth(res)?.scopes ?? []).toSorted();
}

describe("OpenClaw ID tunnel devices on a token-mode Gateway", () => {
  test("an owner device connects without the token and keeps owner/admin scopes", async () => {
    const { ws, res } = await connectTunnel(OWNER_KEY);
    try {
      expect(res.ok).toBe(true);
      expect(grantedScopes(res)).toContain("operator.admin");
      expect(helloAuth(res)?.method).toBe("trusted-proxy");
      expect(helloAuth(res)?.roleAllowsAdmin).toBe(true);
      const admin = await rpcReq(ws, "exec.approvals.get", {});
      expect(admin.ok).toBe(true);
    } finally {
      ws.close();
    }
  });

  test("an owner device of a linked account arrives as that person, keeping owner authority", async () => {
    const person = await profileWrites.ensureCanonicalUserProfileForTailscaleIdentity({
      login: "owner-person@example.test",
      name: "Owner Person",
    });
    setOpenClawIdOwnerAccountResolver(() => "acct_owner");
    const self = async () => {
      const { ws, res } = await connectTunnel(OWNER_KEY);
      try {
        expect(res.ok).toBe(true);
        // Owner authority comes from the certificate: no role ceiling either way.
        expect(grantedScopes(res)).toContain("operator.admin");
        expect(helloAuth(res)?.roleAllowsAdmin).toBe(true);
        expect((await rpcReq(ws, "exec.approvals.get", {})).ok).toBe(true);
        const reply = await rpcReq(ws, "users.self", {});
        return (reply.payload as { profile?: { id?: string } } | undefined)?.profile?.id;
      } finally {
        ws.close();
      }
    };
    try {
      const shared = await self();
      expect(shared).not.toBe(person.id);
      await linkCanonicalOpenClawIdUserProfile({
        profileId: person.id,
        accountId: "acct_owner",
        email: "owner-person@id.test",
      });
      expect(await self()).toBe(person.id);
      await unlinkCanonicalOpenClawIdUserProfile({ profileId: person.id });
      expect(await self()).toBe(shared);
    } finally {
      setOpenClawIdOwnerAccountResolver(undefined);
    }
  });

  test("an operator member chats but is refused admin, config and pairing", async () => {
    const profile = await ensureCanonicalUserProfileForOpenClawIdIdentity({
      accountId: "acct_op",
      name: "Operator Member",
      email: "member@example.test",
    });
    const { ws, res } = await connectTunnel(OPERATOR_KEY);
    try {
      expect(res.ok).toBe(true);
      expect(await rpcReq(ws, "users.self", {})).toMatchObject({
        ok: true,
        payload: { profile: { id: profile.id, displayName: "Operator Member" } },
      });
      const scopes = grantedScopes(res);
      expect(scopes).toEqual(expect.arrayContaining(["operator.read", "operator.write"]));
      expect(scopes).not.toContain("operator.admin");
      expect(scopes).not.toContain("operator.pairing");
      expect(helloAuth(res)?.roleAllowsAdmin).toBe(false);
      for (const method of ["exec.approvals.get", "config.patch", "device.pair.list"]) {
        const refused = await rpcReq(ws, method, {});
        expect(refused.ok, method).toBe(false);
        expect(refused.error?.message, method).toMatch(/missing scope/);
      }
    } finally {
      ws.close();
    }
  });

  test("a downgrade during profile preparation prevents the pending operator connection", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const ensure = profileWrites.ensureCanonicalUserProfileForOpenClawIdIdentity;
    const spy = vi
      .spyOn(profileWrites, "ensureCanonicalUserProfileForOpenClawIdIdentity")
      .mockImplementationOnce(async (...args) => {
        const profile = await ensure(...args);
        entered.resolve();
        await release.promise;
        return profile;
      });
    const original = expectDefined(PRINCIPALS[OPERATOR_KEY], "operator principal");
    const pending = connectTunnel(OPERATOR_KEY);
    try {
      await entered.promise;
      PRINCIPALS[OPERATOR_KEY] = {
        kind: "member",
        peerKey: OPERATOR_KEY,
        accountId: "acct_op",
        role: "viewer",
      };
      release.resolve();
      await expect(pending).rejects.toThrow("closed 4001: gateway auth changed");
    } finally {
      release.resolve();
      PRINCIPALS[OPERATOR_KEY] = original;
      spy.mockRestore();
    }
  });

  test("a connected operator cannot use even a read request after its membership role changes", async () => {
    const original = expectDefined(PRINCIPALS[OPERATOR_KEY], "operator principal");
    const { ws, res } = await connectTunnel(OPERATOR_KEY);
    try {
      expect(res.ok).toBe(true);
      expect((await rpcReq(ws, "health", {})).ok).toBe(true);
      PRINCIPALS[OPERATOR_KEY] = {
        kind: "member",
        peerKey: OPERATOR_KEY,
        accountId: "acct_op",
        role: "viewer",
      };
      await expect(rpcReq(ws, "health", {})).rejects.toThrow(/closed 4001.*membership changed/);
    } finally {
      PRINCIPALS[OPERATOR_KEY] = original;
      ws.close();
    }
  });

  test.each(["removed", "reassigned"] as const)(
    "a tokenless browser is Access-managed and loses RPC access when its peer is %s",
    async (change) => {
      const original = expectDefined(PRINCIPALS[OPERATOR_KEY], "operator principal");
      const gateway = {
        auth: { mode: "token" as const, token: TOKEN },
        controlUi: { allowedOrigins: [BROWSER_ORIGIN] },
      };
      await writeConfigFile({
        gateway: {
          ...gateway,
          openclawId: { enabled: true },
          roles: {
            default: "member",
            definitions: {
              member: {
                sessions: { others: "none" },
                agents: "*",
                scopes: ["operator.read", "operator.write"],
              },
            },
          },
        },
      });
      let browser: WebSocket | undefined;
      let admin: WebSocket | undefined;
      try {
        const connected = await connectTunnel(OPERATOR_KEY);
        browser = connected.ws;
        expect(connected.res.ok, JSON.stringify(connected.res.error)).toBe(true);
        expect(helloAuth(connected.res)?.deviceToken).toBeUndefined();
        expect(grantedScopes(connected.res)).toEqual([
          "operator.approvals",
          "operator.questions",
          "operator.read",
          "operator.talk",
          "operator.write",
        ]);
        const deviceId = expectDefined(
          (await listDevicePairing()).paired[0]?.deviceId,
          "browser pairing",
        );
        const owner = await connectTunnel(undefined, { token: TOKEN });
        admin = owner.ws;
        expect(owner.res.ok).toBe(true);
        const list = await rpcReq<{ paired: Array<{ deviceId: string; managedBy?: string }> }>(
          admin,
          "device.pair.list",
          {},
        );
        expect(list.payload?.paired.find((entry) => entry.deviceId === deviceId)?.managedBy).toBe(
          "openclaw-id",
        );
        expect((await rpcReq(browser, "health", {})).ok).toBe(true);
        expect((await rpcReq(browser, "exec.approvals.get", {})).ok).toBe(false);
        if (change === "removed") {
          delete PRINCIPALS[OPERATOR_KEY];
        } else {
          PRINCIPALS[OPERATOR_KEY] = {
            ...original,
            kind: "member",
            accountId: "acct_reassigned",
            role: "operator",
          };
        }
        await expect(rpcReq(browser, "health", {})).rejects.toThrow(
          /closed 4001.*membership changed/,
        );
      } finally {
        PRINCIPALS[OPERATOR_KEY] = original;
        browser?.close();
        admin?.close();
        await writeConfigFile({ gateway });
      }
    },
  );

  test("a viewer member reads but is refused chat.send", async () => {
    const { ws, res } = await connectTunnel(VIEWER_KEY);
    try {
      expect(res.ok).toBe(true);
      expect(grantedScopes(res)).toEqual(["operator.read"]);
      const send = await rpcReq(ws, "chat.send", {
        sessionKey: "main",
        message: "hi",
        idempotencyKey: randomUUID(),
      });
      expect(send.ok).toBe(false);
      expect(send.error?.message).toMatch(/missing scope: operator.write/);
    } finally {
      ws.close();
    }
  });

  test("a member presenting the Gateway token over the tunnel stays capped", async () => {
    const { ws, res } = await connectTunnel(VIEWER_KEY, { token: TOKEN });
    try {
      expect(res.ok).toBe(true);
      expect(grantedScopes(res)).toEqual(["operator.read"]);
    } finally {
      ws.close();
    }
  });

  test("a viewer cannot replace its tunnel role with a valid owner bootstrap credential", async () => {
    const issued = await issueDeviceBootstrapToken({ profile: CONTROL_UI_OWNER_BOOTSTRAP_PROFILE });
    const { ws, res } = await connectTunnel(VIEWER_KEY, { bootstrapToken: issued.token });
    try {
      expect(res.ok).toBe(true);
      expect(helloAuth(res)?.method).toBe("trusted-proxy");
      expect(grantedScopes(res)).toEqual(["operator.read"]);
      expect((await rpcReq(ws, "config.patch", {})).ok).toBe(false);
    } finally {
      ws.close();
    }
  });

  // OCF-495: remote sign-out revokes the browser's tokens but keeps its device approved.
  async function pairThenSignOut(peerKey: string, scopes = CONTROL_UI_SCOPES) {
    const identityPath = makeIdentityPath(`openclaw-tunnel-signout-${randomUUID()}.sqlite`);
    const first = await connectTunnel(peerKey, { identityPath, scopes });
    first.ws.close();
    expect(first.res.ok).toBe(true);
    const deviceId = expectDefined(
      (await listDevicePairing()).paired.find((entry) => entry.publicKey)?.deviceId,
      "paired device",
    );
    expect(await revokeDeviceToken({ deviceId, role: "operator" })).toMatchObject({ ok: true });
    return { identityPath, deviceId };
  }

  test.each([
    { who: "owner", peerKey: OWNER_KEY },
    { who: "operator member", peerKey: OPERATOR_KEY },
  ])("a signed-out $who browser reconnects with its approved access", async ({ peerKey }) => {
    const { identityPath, deviceId } = await pairThenSignOut(peerKey);
    const approvedScopes = (await getPairedDevice(deviceId))?.approvedScopes;
    const again = await connectTunnel(peerKey, { identityPath });
    try {
      expect(again.res.ok, JSON.stringify(again.res.error)).toBe(true);
      expect((await listDevicePairing()).pending).toEqual([]);
      expect((await getPairedDevice(deviceId))?.approvedScopes).toEqual(approvedScopes);
    } finally {
      again.ws.close();
    }
  });

  test("a signed-out browser asking for more than it was approved still needs approval", async () => {
    const { identityPath } = await pairThenSignOut(OWNER_KEY, ["operator.read"]);
    const again = await connectTunnel(OWNER_KEY, { identityPath });
    try {
      expect(again.res.ok).toBe(false);
      expect((await listDevicePairing()).pending).toEqual([
        expect.objectContaining({ role: "operator", isRepair: true }),
      ]);
    } finally {
      again.ws.close();
    }
  });

  test("a signed-out browser asking for fewer scopes reconnects with only those", async () => {
    const { identityPath, deviceId } = await pairThenSignOut(OWNER_KEY);
    const again = await connectTunnel(OWNER_KEY, { identityPath, scopes: ["operator.read"] });
    try {
      expect(again.res.ok, JSON.stringify(again.res.error)).toBe(true);
      expect(grantedScopes(again.res)).toEqual(["operator.read"]);
      expect((await getPairedDevice(deviceId))?.tokens?.operator?.scopes).toEqual([
        "operator.read",
      ]);
    } finally {
      again.ws.close();
    }
  });

  test("a restore merged with a pending new role names that role and waits", async () => {
    const { identityPath, deviceId } = await pairThenSignOut(OWNER_KEY);
    const paired = expectDefined(await getPairedDevice(deviceId), "paired device");
    await requestDevicePairing({ deviceId, publicKey: paired.publicKey, role: "node", scopes: [] });
    const again = await connectTunnel(OWNER_KEY, { identityPath });
    try {
      expect(again.res.ok).toBe(false);
      expect(again.res.error?.details).toMatchObject({
        reason: "role-upgrade",
        requestedRole: "node",
        approvedRoles: ["operator"],
      });
    } finally {
      again.ws.close();
    }
  });

  test("a key the authority no longer admits is refused", async () => {
    const { ws, res } = await connectTunnel(REMOVED_KEY);
    try {
      expect(res.ok).toBe(false);
      expect(res.error?.message).toMatch(/no longer has access to this claw/);
    } finally {
      ws.close();
    }
  });

  test("loopback token auth is unchanged", async () => {
    const { ws, res } = await connectTunnel(undefined, { token: TOKEN });
    try {
      expect(res.ok).toBe(true);
      expect(grantedScopes(res)).toContain("operator.admin");
    } finally {
      ws.close();
    }
    const missing = await connectTunnel(undefined);
    try {
      expect(missing.res.ok).toBe(false);
    } finally {
      missing.ws.close();
    }
  });

  // Josh (2026-11-08): OpenClaw ID browsers are managed on the Access page, not as devices.
  test("an OpenClaw ID browser is listed as managed by Access and refuses device removal", async () => {
    const gateway = {
      auth: { mode: "token" as const, token: TOKEN },
      controlUi: { allowedOrigins: [BROWSER_ORIGIN] },
    };
    const browserIdentity = makeIdentityPath(`openclaw-tunnel-managed-${randomUUID()}.sqlite`);
    const tunnel = await connectTunnel(OWNER_KEY, { identityPath: browserIdentity });
    tunnel.ws.close();
    const other = await connectTunnel(undefined, { token: TOKEN });
    other.ws.close();
    const before = new Set((await listDevicePairing()).paired.map((d) => d.deviceId));
    const admin = await connectTunnel(undefined, { token: TOKEN });
    try {
      await writeConfigFile({ gateway: { ...gateway, openclawId: { enabled: true } } });
      const list = await rpcReq<{ paired: Array<{ deviceId: string; managedBy?: string }> }>(
        admin.ws,
        "device.pair.list",
        {},
      );
      const managed = list.payload?.paired.filter((d) => d.managedBy === "openclaw-id") ?? [];
      expect(managed).toHaveLength(1);
      expect(list.payload?.paired).toHaveLength(3);
      const deviceId = managed[0]!.deviceId;
      for (const [method, params] of [
        ["device.pair.remove", { deviceId }],
        ["device.token.revoke", { deviceId, role: "operator" }],
      ] as const) {
        const refused = await rpcReq(admin.ws, method, params);
        expect(refused.ok).toBe(false);
        expect(refused.error?.message).toBe(
          "This browser connects through OpenClaw ID. Manage access on the Access page.",
        );
      }
      expect((await getPairedDevice(deviceId))?.tokens?.operator?.revokedAtMs).toBeUndefined();
      // Sign-out revokes the token and keeps its binding: still an OpenClaw ID browser.
      await revokeDeviceToken({ deviceId, role: "operator" });
      const signedOut = await rpcReq(admin.ws, "device.pair.remove", { deviceId });
      expect(signedOut.error?.message).toMatch(/^This browser connects through OpenClaw ID/);
      // Any other device keeps main's behavior.
      const otherId = list.payload!.paired.find(
        (d) => !d.managedBy && before.has(d.deviceId),
      )!.deviceId;
      expect((await rpcReq(admin.ws, "device.pair.remove", { deviceId: otherId })).ok).toBe(true);
      // With OpenClaw ID off there is no Access page, so the browser is an ordinary device again.
      await writeConfigFile({ gateway });
      expect((await rpcReq(admin.ws, "device.pair.remove", { deviceId })).ok).toBe(true);
      // The deleted pairing's binding goes with it: the same identity, paired again on
      // ordinary ingress, starts as an ordinary device.
      const reused = await connectTunnel(undefined, {
        token: TOKEN,
        identityPath: browserIdentity,
      });
      reused.ws.close();
      expect(reused.res.ok).toBe(true);
      await writeConfigFile({ gateway: { ...gateway, openclawId: { enabled: true } } });
      const relisted = await rpcReq<{ paired: Array<{ managedBy?: string }> }>(
        admin.ws,
        "device.pair.list",
        {},
      );
      expect(relisted.payload?.paired.some((d) => d.managedBy)).toBe(false);
    } finally {
      admin.ws.close();
      await writeConfigFile({ gateway });
    }
  });

  // The synthetic tunnel address is in fd00::/8 and in SSH verification's private default scope.
  test.each([
    { path: "trusted CIDR", pairing: { autoApproveCidrs: ["fd00::/8"], sshVerify: false } },
    { path: "SSH verification", pairing: {} },
  ])("a node over the tunnel is never auto-approved by $path", async ({ pairing }) => {
    const gateway = {
      auth: { mode: "token" as const, token: TOKEN },
      controlUi: { allowedOrigins: [BROWSER_ORIGIN] },
    };
    await writeConfigFile({ gateway: { ...gateway, nodes: { pairing } } });
    sshProbe.mockClear();
    const ws: WebSocket = await openWs(started!.port, { [TEST_PEER_HEADER]: OWNER_KEY });
    try {
      const res = await connectReq(ws, {
        role: "node",
        scopes: [],
        skipDefaultAuth: true,
        client: {
          id: GATEWAY_CLIENT_NAMES.NODE_HOST,
          version: "1.0.0",
          platform: "ios",
          mode: GATEWAY_CLIENT_MODES.NODE,
        },
        deviceIdentityPath: makeIdentityPath(`openclaw-tunnel-node-${randomUUID()}.sqlite`),
      });
      expect(res.ok).toBe(false);
      expect(res.error?.details).toMatchObject({ reason: "not-paired" });
      expect((await listDevicePairing()).pending).toEqual([
        expect.objectContaining({ role: "node", silent: false }),
      ]);
      expect(sshProbe).not.toHaveBeenCalled();
    } finally {
      ws.close();
      await writeConfigFile({ gateway });
    }
  });
});
