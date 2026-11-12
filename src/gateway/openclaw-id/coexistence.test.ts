// The canonical ingress classifier feeds the same locality facts as the WS handshake.
// Exercise the actual ID handlers/authority for each existing remote-access door.
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { authorizeWsControlUiGatewayConnect } from "../auth.js";
import {
  markGatewayIngressTransport,
  prepareGatewayIngressAttribution,
} from "../ingress-attribution.js";
import { openclawIdHandlers } from "../server-methods/openclaw-id.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { linkedClaw, serviceFor } from "./openclaw-id.test-support.js";

const proxy = { userHeader: "custom-user", requiredHeaders: ["custom-proof"], allowLoopback: true };

// Carries only listener-classified facts, as connect-session does after authentication.
function classify(kind: "direct" | "access" | "serve" | "tailnet") {
  const req = {
    socket: { remoteAddress: kind === "tailnet" ? "100.64.0.9" : "127.0.0.1" },
    headers:
      kind === "access" || kind === "serve"
        ? {
            "x-forwarded-for": "100.64.0.9",
            "x-forwarded-proto": "https",
            "x-forwarded-host": "gateway.example.test",
            "custom-user": "remote@example.test",
            "custom-proof": "assertion",
            "tailscale-user-login": "remote@example.test",
          }
        : {},
  } as IncomingMessage;
  if (kind === "serve") {
    markGatewayIngressTransport(req, { kind: "managed-tailscale", mode: "serve" });
  }
  const ingress = prepareGatewayIngressAttribution({
    req,
    trustedProxies: ["127.0.0.1"],
    trustedProxy: proxy,
    tailscaleWhois: async () => ({ login: "remote@example.test", name: "Remote" }),
  });
  return { req, ingress, client: { internal: { isLocalClient: ingress.kind === "direct-local" } } };
}

describe("OpenClaw ID coexistence", () => {
  it("admits Access and Serve users without granting local ceremonies or People", async () => {
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority);
    const rootPub = claw.authority.current()?.authority?.anchor.root_pub;
    const signedChange = await claw.sign({ op: "remove", account_id: "nobody" });
    for (const kind of ["access", "serve", "tailnet"] as const) {
      const { req, ingress, client } = classify(kind);
      const auth =
        kind === "access"
          ? { mode: "trusted-proxy" as const, allowTailscale: false, trustedProxy: proxy }
          : { mode: "token" as const, token: "fixture-token", allowTailscale: true };
      expect(
        await authorizeWsControlUiGatewayConnect({
          req,
          ingressAttribution: ingress,
          auth,
          trustedProxies: ["127.0.0.1"],
          ...(kind === "tailnet" ? { connectAuth: { token: "fixture-token" } } : {}),
        }),
      ).toMatchObject({ ok: true });
      const requests: Array<[string, Record<string, unknown>]> = [
        ["openclawId.people", {}],
        ...["account_begin", "check_name", "prepare"].map(
          (action): [string, Record<string, unknown>] => ["openclawId.authority", { action }],
        ),
        [
          "openclawId.authority",
          {
            action: "commit",
            rootPub,
            ownerDevice: await claw.sign({ op: "add_owner_device", cert: claw.cert }),
            binding: signedChange,
          },
        ],
        ["openclawId.authority", { action: "submit", statement: signedChange }],
      ];
      for (const [method, params] of requests) {
        let accepted: boolean | undefined;
        await openclawIdHandlers[method]!({
          params,
          client,
          respond: (ok: boolean) => {
            accepted = ok;
          },
          context: {
            openclawIdService: service,
            getRuntimeConfig: () => ({ gateway: { openclawId: { enabled: true } } }),
          },
        } as unknown as GatewayRequestHandlerOptions);
        expect(accepted, `${kind}: ${method} ${JSON.stringify(params.action)}`).toBe(false);
      }
      expect(claw.authority.current()?.authority?.anchor.root_pub).toBe(rootPub);
    }
    expect(classify("direct").client.internal.isLocalClient).toBe(true);
  });
});
