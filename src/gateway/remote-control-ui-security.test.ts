import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { REDACTED_SENTINEL } from "../config/redact-sentinel.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureGatewayAuthPolicy, isGatewayAuthPolicyCurrent } from "./auth-policy.js";
import {
  authorizeControlUiReadHttpGatewayConnect,
  authorizeWsControlUiGatewayConnect,
  type ResolvedGatewayAuth,
} from "./auth.js";
import {
  markGatewayIngressTransport,
  prepareGatewayIngressAttribution,
} from "./ingress-attribution.js";
import { checkGatewayWsBrowserOrigin } from "./origin-check.js";
import { getRemoteControlUiIngressContext } from "./remote-control-ui-context.js";
import { createRemoteControlUiIngressTestContext } from "./remote-control-ui.test-support.js";
import { admitGatewayConnect } from "./server/ws-connection/connect-admission.js";
import type { GatewayConnectPhaseContext } from "./server/ws-connection/message-handler-types.js";
import { disconnectDisallowedGatewayPolicyClients } from "./server/ws-origin-policy.js";

afterEach(() => clearRuntimeConfigSnapshot());

it.each(["token", "password"] as const)(
  "preserves the canonical redacted %s rejection on remote ingress",
  async (mode) => {
    const auth: ResolvedGatewayAuth = { mode, [mode]: REDACTED_SENTINEL, allowTailscale: false };
    for (const authorize of [
      authorizeWsControlUiGatewayConnect,
      authorizeControlUiReadHttpGatewayConnect,
    ]) {
      await expect(
        authorize({ req: remoteRequest(), auth, connectAuth: null }),
      ).resolves.toMatchObject({
        ok: false,
        reason: `${mode}_redacted_config`,
      });
    }
  },
);

function remoteRequest(headers: IncomingMessage["headers"] = {}) {
  const req = new IncomingMessage(new Socket());
  req.headers = { host: "localhost", ...headers };
  markGatewayIngressTransport(req, {
    kind: "remote-forwarded",
    context: createRemoteControlUiIngressTestContext(),
  });
  return req;
}

describe("remote Control UI ingress security", () => {
  it("cannot regain local, proxy, or Tailscale attribution or vary its plugin budget by claimed IP", () => {
    const attributions = ["127.0.0.1", "203.0.113.9"].map((ip) => {
      const req = remoteRequest({
        "x-forwarded-for": ip,
        "x-forwarded-proto": "https",
        "x-forwarded-host": "tailnet.ts.net",
        "tailscale-user-login": "owner@example.test",
      });
      const tailscaleWhois = vi.fn();
      const attribution = prepareGatewayIngressAttribution({
        req,
        trustedProxies: ["127.0.0.1"],
        tailscaleWhois,
      });
      expect(attribution.kind).toBe("remote-forwarded");
      expect(tailscaleWhois).not.toHaveBeenCalled();
      expect(() => markGatewayIngressTransport(req, { kind: "ordinary" })).toThrow(
        "already assigned",
      );
      expect(() => Reflect.set(attribution, "kind", "direct-local")).not.toThrow();
      expect(attribution.kind).toBe("remote-forwarded");
      return attribution;
    });
    expect(attributions).toMatchObject([
      { rateLimit: { subject: { key: "remote-control-ui:remote-ui-test" } } },
      { rateLimit: { subject: { key: "remote-control-ui:remote-ui-test" } } },
    ]);
  });

  it.each([
    { mode: "none", allowTailscale: false },
    { mode: "token", token: "shared-test-token", allowTailscale: true },
    { mode: "password", password: "shared-test-password", allowTailscale: false },
    { mode: "trusted-proxy", trustedProxy: { userHeader: "x-user" }, allowTailscale: false },
  ] satisfies ResolvedGatewayAuth[])(
    "refuses $mode authentication at both shared auth entry points",
    async (auth) => {
      const req = remoteRequest({
        "x-user": "owner@example.test",
        "tailscale-user-login": "owner@example.test",
      });
      for (const authorize of [
        authorizeWsControlUiGatewayConnect,
        authorizeControlUiReadHttpGatewayConnect,
      ]) {
        await expect(
          authorize({
            req,
            auth,
            connectAuth: { token: "shared-test-token", password: "shared-test-password" },
            trustedProxies: ["127.0.0.1"],
          }),
        ).resolves.toEqual({ ok: false, reason: "remote_control_ui_device_auth_required" });
      }
    },
  );

  it.each([
    undefined,
    "null",
    "https://ui.example.test/",
    "https://other.example.test",
    "http://localhost",
  ])("requires the exact handle origin even when global fallback would allow %s", (origin) => {
    const ingress = createRemoteControlUiIngressTestContext();
    expect(
      checkGatewayWsBrowserOrigin(
        {
          requestHost: "localhost",
          origin,
          isLocalClient: true,
          remoteControlUiIngress: ingress,
        },
        {
          gateway: {
            controlUi: { allowedOrigins: ["*"], dangerouslyAllowHostHeaderOriginFallback: true },
          },
        },
      ),
    ).toMatchObject({ ok: false });
  });

  it("keeps the origin allowance on its handle and revokes already admitted clients", () => {
    const lifetime = new AbortController();
    const remoteControlUiIngress = createRemoteControlUiIngressTestContext({
      signal: lifetime.signal,
    });
    const origin = { origin: remoteControlUiIngress.publicOrigin, remoteControlUiIngress };
    expect(checkGatewayWsBrowserOrigin(origin, {})).toMatchObject({ ok: true });
    expect(checkGatewayWsBrowserOrigin({ origin: origin.origin }, {})).toMatchObject({ ok: false });
    const client = { browserOrigin: origin, socket: { close: vi.fn() } };
    lifetime.abort();
    disconnectDisallowedGatewayPolicyClients([client], {});
    expect(client.socket.close).toHaveBeenCalledWith(1008, "origin not allowed");
  });

  it("keeps matching audiences' live policy authority independent across handle replacement", () => {
    const previous = new AbortController();
    const config: OpenClawConfig = { gateway: { auth: { mode: "token", token: "test-token" } } };
    const capture = (signal: AbortSignal) =>
      captureGatewayAuthPolicy(config, {
        role: "operator",
        authMethod: "remote-ingress",
        browserOrigin: {
          origin: "https://ui.example.test",
          remoteControlUiIngress: createRemoteControlUiIngressTestContext({ signal }),
        },
      });
    const oldPolicy = capture(previous.signal);
    const currentPolicy = capture(new AbortController().signal);
    previous.abort();
    const nextConfig = { ...config };
    expect(isGatewayAuthPolicyCurrent(oldPolicy, nextConfig)).toBe(false);
    expect(isGatewayAuthPolicyCurrent(currentPolicy, nextConfig)).toBe(true);
  });

  it.each([
    {
      name: "device-less",
      change: { device: undefined },
      message: "requires a signed device identity",
    },
    { name: "node role", change: { role: "node" }, message: "only admits the operator role" },
    {
      name: "paired device token",
      change: { auth: { deviceToken: "paired-test-token" } },
      message: "credential-free signed device",
    },
    {
      name: "shared token",
      change: { auth: { token: "shared-test-token" } },
      message: "credential-free signed device",
    },
    {
      name: "shared password",
      change: { auth: { password: "shared-test-password" } },
      message: "credential-free signed device",
    },
    {
      name: "bootstrap token",
      change: { auth: { bootstrapToken: "bootstrap-test" } },
      message: "credential-free signed device",
    },
    ...[
      "operator.admin",
      "operator.approvals",
      "operator.questions",
      "operator.pairing",
      "operator.talk.secrets",
    ].map((scope) => ({ name: scope, change: { scopes: [scope] }, message: "ceiling" })),
  ])("rejects $name before device authentication or local pairing", async ({ change, message }) => {
    const config: OpenClawConfig = {
      gateway: { auth: { mode: "token", token: "shared-test-token" } },
    };
    setRuntimeConfigSnapshot(config);
    const req = remoteRequest();
    const connectParams: ConnectParams = {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { id: "openclaw-control-ui", mode: "webchat", platform: "test", version: "test" },
      role: "operator",
      scopes: ["operator.read"],
      device: {
        id: "test-device",
        publicKey: "test-public-key",
        signature: "test-signature",
        signedAt: 1,
        nonce: "test-nonce",
      },
      ...change,
    };
    const sendHandshakeErrorResponse = vi.fn();
    const close = vi.fn();
    const context = {
      handler: {
        upgradeReq: req,
        getResolvedAuth: () => ({
          mode: "token",
          token: "shared-test-token",
          allowTailscale: false,
        }),
        close,
      },
      connectParams,
      configSnapshot: config,
      markHandshakeFailure: vi.fn(),
      sendHandshakeErrorResponse,
    } as unknown as GatewayConnectPhaseContext;
    expect(getRemoteControlUiIngressContext(req)).toBeDefined();
    await expect(admitGatewayConnect(context)).resolves.toBeUndefined();
    expect(sendHandshakeErrorResponse).toHaveBeenCalledWith(
      "FORBIDDEN",
      expect.stringContaining(message),
    );
    expect(close).toHaveBeenCalledWith(1008, expect.any(String));
  });
});
