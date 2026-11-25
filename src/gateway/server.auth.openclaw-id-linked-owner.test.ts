// An OpenClaw ID owner device whose account is linked to a personal profile (OCF-510) arrives
// as that person but keeps owner authority from its certificate: the person's named role,
// however restricted, never caps it, on connect or in personal APIs.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import http, { type IncomingMessage } from "node:http";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { writeConfigFile } from "../config/config.js";
import { linkCanonicalOpenClawIdUserProfile } from "../state/user-profile-openclaw-id.js";
import { ensureCanonicalUserProfileForTailscaleIdentity } from "../state/user-profile-writes.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { setDeviceTokenBindingOwner } from "./openclaw-id/device-token-binding.js";
import { setOpenClawIdOwnerAccountResolver } from "./openclaw-id/owner-account.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  setOpenClawIdTunnelPrincipalResolver,
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

const makeIdentityPath = useAuthIdentityFixture();
const TEST_PEER_HEADER = "x-test-openclaw-id-peer";
const OWNER_KEY = `iroh:${"1a".repeat(32)}`;
const OWNER: OpenClawIdTunnelPrincipal = { kind: "owner", peerKey: OWNER_KEY };
let started: Awaited<ReturnType<typeof createGatewaySuiteHarness>> | undefined;

// Stands in for the ingress listener, as in server.auth.openclaw-id-tunnel.test.ts.
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
      auth: { mode: "token", token: "linked-owner-secret" },
      controlUi: { allowedOrigins: [BROWSER_ORIGIN] },
      // Every person defaults to a role that cannot even read.
      roles: {
        default: "talker",
        definitions: {
          talker: { scopes: ["operator.talk"], agents: [], sessions: { others: "none" } },
        },
      },
    },
  });
  started = await createGatewaySuiteHarness();
  setOpenClawIdTunnelPrincipalResolver(async (peerKey) =>
    peerKey === OWNER_KEY ? OWNER : undefined,
  );
  setOpenClawIdTunnelPrincipalLookup((peerKey) => (peerKey === OWNER_KEY ? OWNER : undefined));
  setOpenClawIdOwnerAccountResolver(() => "acct_owner");
  const bindings = new Map<string, string>();
  setDeviceTokenBindingOwner({
    lookup: (deviceId, role) => bindings.get(`${deviceId}:${role}`),
    record: async (deviceId, role, peerKey) => {
      bindings.set(`${deviceId}:${role}`, peerKey);
    },
    forget: async () => {},
    reportMismatch: () => {},
  });
});

afterAll(async () => {
  setDeviceTokenBindingOwner(undefined);
  setOpenClawIdOwnerAccountResolver(undefined);
  setOpenClawIdTunnelPrincipalResolver(undefined);
  setOpenClawIdTunnelPrincipalLookup(undefined);
  await started?.close();
  vi.restoreAllMocks();
});

test("a linked owner device keeps owner authority under its person's restricted role", async () => {
  const person = await ensureCanonicalUserProfileForTailscaleIdentity({
    login: "restricted-owner@example.test",
    name: "Restricted Owner",
  });
  await linkCanonicalOpenClawIdUserProfile({
    profileId: person.id,
    accountId: "acct_owner",
    email: null,
  });
  const ws = await openWs(started!.port, { origin: BROWSER_ORIGIN, [TEST_PEER_HEADER]: OWNER_KEY });
  try {
    const res = await connectReq(ws, {
      client: CONTROL_UI_CLIENT,
      scopes: ["operator.admin", "operator.read", "operator.write"],
      deviceIdentityPath: makeIdentityPath(`openclaw-linked-owner-${randomUUID()}.sqlite`),
      skipDefaultAuth: true,
      browserOrigin: BROWSER_ORIGIN,
    });
    expect(res.ok, JSON.stringify(res.error)).toBe(true);
    expect((res.payload as { auth?: { scopes?: string[] } }).auth?.scopes).toContain(
      "operator.admin",
    );
    expect(await rpcReq(ws, "users.self", {})).toMatchObject({
      ok: true,
      payload: { profile: { id: person.id } },
    });
    expect((await rpcReq(ws, "exec.approvals.get", {})).ok).toBe(true);
    // Personal APIs select the person's data without applying the person's role to the owner.
    const github = await rpcReq(ws, "users.github.status", {});
    expect(github.error?.message ?? "").not.toMatch(/Personal profile requires/);
    const background = await rpcReq(ws, "users.background.get", {});
    expect(background.ok, JSON.stringify(background.error)).toBe(true);
    const library = await rpcReq(ws, "skills.library.list", {});
    expect(library.ok, JSON.stringify(library.error)).toBe(true);
    // A committed, unrelated config change keeps the owner's admin grants and connection.
    const closed = new Promise<boolean>((resolve) => {
      ws.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 1_500);
    });
    await writeConfigFile({
      gateway: {
        auth: { mode: "token", token: "linked-owner-secret" },
        controlUi: { allowedOrigins: [BROWSER_ORIGIN] },
        roles: {
          default: "talker",
          definitions: {
            talker: { scopes: ["operator.talk"], agents: [], sessions: { others: "none" } },
            reader: { scopes: ["operator.read"], agents: [], sessions: { others: "none" } },
          },
        },
      },
    });
    expect(await closed).toBe(false);
    expect((await rpcReq(ws, "exec.approvals.get", {})).ok).toBe(true);
    // Assigning the person another role changes neither the owner device nor its grants.
    const roleClosed = new Promise<boolean>((resolve) => {
      ws.once("close", () => resolve(true));
      setTimeout(() => resolve(false), 1_500);
    });
    const assigned = await rpcReq(ws, "users.setRole", { profileId: person.id, role: "reader" });
    expect(assigned.ok, JSON.stringify(assigned.error)).toBe(true);
    expect(await roleClosed).toBe(false);
    expect((await rpcReq(ws, "exec.approvals.get", {})).ok).toBe(true);
  } finally {
    ws.close();
  }
});
