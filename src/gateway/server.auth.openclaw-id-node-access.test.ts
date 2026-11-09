// Node transport admission must never become an operator or ambient HTTP credential.
import { EventEmitter } from "node:events";
import http, { type IncomingMessage } from "node:http";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { writeConfigFile } from "../config/config.js";
import { listDevicePairing } from "../infra/device-pairing.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  setOpenClawIdTunnelPrincipalResolver,
  type OpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import { useAuthIdentityFixture } from "./server.auth.identity-fixture.test-support.js";
import { NODE_CLIENT, openWs } from "./server.auth.test-helpers.js";
import {
  connectReq,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const identityPath = useAuthIdentityFixture();
const peerKey = `iroh:${"a3".repeat(32)}`;
const principal: OpenClawIdTunnelPrincipal = {
  kind: "node",
  peerKey,
  authority: { clawId: "node-access", rootPub: `ed25519:${"a4".repeat(32)}`, listedSeq: 2 },
};
let server: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
const header = "x-test-tunnel-peer";

beforeAll(async () => {
  vi.spyOn(http.Server.prototype, "emit").mockImplementation(function (
    this: http.Server,
    event,
    ...args
  ) {
    if (event === "request" || event === "upgrade") {
      const req = args[0] as IncomingMessage;
      if (req.headers?.[header] === peerKey) {
        delete req.headers[header];
        markGatewayIngressTransport(req, {
          kind: "openclaw-id-tunnel",
          peerKey,
          clientIp: "fd69:726f:6800::3",
        });
      }
    }
    return EventEmitter.prototype.emit.call(this, event, ...args);
  });
  testState.gatewayAuth = undefined;
  await writeConfigFile({ gateway: { auth: { mode: "token", token: "node-access-test-secret" } } });
  server = await createGatewaySuiteHarness();
  setOpenClawIdTunnelPrincipalResolver(async (key) => (key === peerKey ? principal : undefined));
  setOpenClawIdTunnelPrincipalLookup((key) => (key === peerKey ? principal : undefined));
});
afterAll(async () => {
  setOpenClawIdTunnelPrincipalResolver(undefined);
  setOpenClawIdTunnelPrincipalLookup(undefined);
  await server?.close();
  vi.restoreAllMocks();
});

test.each([
  ["operator", "cli"],
  ["node", "cli"],
] as const)(
  "refuses node key requesting role %s and mode %s before pairing",
  async (role, mode) => {
    const before = (await listDevicePairing()).pending.length;
    const ws = await openWs(server.port, { [header]: peerKey });
    try {
      const res = await connectReq(ws, {
        client: { ...NODE_CLIENT, mode },
        role,
        scopes: ["operator.admin"],
        skipDefaultAuth: true,
        deviceIdentityPath: identityPath(`node-access-${role}-${mode}`),
      });
      expect(res.ok).toBe(false);
      expect(res.error?.message).toContain('node keys require role "node" and client mode "node"');
      expect((await listDevicePairing()).pending).toHaveLength(before);
    } finally {
      ws.close();
    }
  },
);

test("does not grant operator HTTP access or issue plugin cookies, even with an owner token", async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/tools/invoke`, {
    method: "POST",
    headers: {
      [header]: peerKey,
      authorization: "Bearer node-access-test-secret",
      "content-type": "application/json",
    },
    body: JSON.stringify({ tool: "session_status", args: {} }),
  });
  expect(res.status).toBe(401);
  expect(res.headers.get("set-cookie")).toBeNull();
  await res.arrayBuffer();
});
