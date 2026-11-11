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
import {
  listDevicePairing,
  rejectDevicePairing,
  removePairedDevice,
} from "../infra/device-pairing.js";
import { createDeferredCore } from "../shared/deferred.js";
import { CONTROL_UI_OWNER_BOOTSTRAP_PROFILE } from "../shared/device-bootstrap-profile.js";
import { ensureCanonicalUserProfileForOpenClawIdIdentity } from "../state/user-profile-openclaw-id.js";
import * as profileWrites from "../state/user-profile-writes.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { setDeviceTokenBindingOwner } from "./openclaw-id/device-token-binding.js";
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
  options: { token?: string; bootstrapToken?: string } = {},
) {
  const ws: WebSocket = await openWs(started!.port, {
    origin: BROWSER_ORIGIN,
    ...(peerKey ? { [TEST_PEER_HEADER]: peerKey } : {}),
  });
  const res = await connectReq(ws, {
    client: CONTROL_UI_CLIENT,
    scopes: CONTROL_UI_SCOPES,
    deviceIdentityPath: makeIdentityPath(`openclaw-tunnel-${randomUUID()}.sqlite`),
    ...(options.token ? { token: options.token } : { skipDefaultAuth: true }),
    ...(options.bootstrapToken ? { bootstrapToken: options.bootstrapToken } : {}),
    browserOrigin: BROWSER_ORIGIN,
  });
  return { ws, res };
}

type HelloAuth = { method?: string; scopes?: string[]; roleAllowsAdmin?: boolean };

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
