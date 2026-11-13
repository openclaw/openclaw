// Control UI sign-in with OpenClaw ID (OCF-285) through a real Gateway: only a
// direct-loopback Control UI can start a sign-in. A browser on a hostile Origin is
// refused at connect, a proxied or LAN client is refused at the method, and even
// the loopback operator cannot point the issuer's redirect at a LAN or tunnel origin.
// A proxied connection never reaches a method (403 at the upgrade); a tunnel or LAN
// client is refused at the method (handler level: tunnel attribution comes from the
// ingress listener and a LAN address from a non-loopback socket, neither of which
// this harness can produce).
import { describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { ConnectErrorDetailCodes } from "../../packages/gateway-protocol/src/connect-error-details.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { resolveOpenClawIdSignInRoute } from "./openclaw-id/channel.js";
import { openclawIdHandlers } from "./server-methods/openclaw-id.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { TEST_OPERATOR_CLIENT, openWs } from "./server.auth.test-helpers.js";
import {
  connectOk,
  connectReq,
  installGatewayTestHooks,
  rpcReq,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const OPENCLAW_ID = {
  enabled: true,
  issuerUrl: "https://issuer.example.test/api/auth",
  clientId: "control-ui",
};
const LOOPBACK_REDIRECT = "http://127.0.0.1:18789/openclaw-id/callback";

// Runs `run` against a Gateway with OpenClaw ID on and sign-in configured.
async function withOpenClawIdGateway(run: (port: number) => Promise<void>) {
  const { writeConfigFile } = await import("../config/config.js");
  await writeConfigFile({ gateway: { openclawId: OPENCLAW_ID } });
  await withGatewayServer(async ({ port }) => run(port));
}

// Calls an OpenClaw ID method as `client` and returns the refusal code, if any.
async function authorityRefusal(
  client: unknown,
  params: Record<string, unknown>,
  openclawId: Record<string, unknown> = OPENCLAW_ID,
  method: "openclawId.authority" | "openclawId.account" = "openclawId.authority",
) {
  let refusal: string | undefined;
  await openclawIdHandlers[method]!({
    params,
    client,
    respond: (_ok: boolean, _payload: unknown, error?: { details?: { code?: string } }) => {
      refusal = error?.details?.code;
    },
    context: {
      openclawIdService: {},
      getRuntimeConfig: () => ({ gateway: { openclawId } }),
    },
  } as unknown as GatewayRequestHandlerOptions);
  return refusal;
}

// A Control UI connection admitted with a verified identity's own profile (Tailscale Serve).
const personal = {
  connect: { role: "operator", scopes: ["operator.read"] },
  internal: { authenticatedOperator: true },
  authenticatedUserProfile: { profileId: "profile-josh" },
};

// Starts a sign-in over `ws` and returns the refusal code, if any.
async function beginSignIn(ws: Awaited<ReturnType<typeof openWs>>, redirectUri: string) {
  const res = await rpcReq(ws, "openclawId.authority", { action: "account_begin", redirectUri });
  return res.ok ? undefined : (res.error?.details as { code?: string } | undefined)?.code;
}

describe("OpenClaw ID sign-in locality", () => {
  test("refuses a browser on a hostile Origin before any method runs", async () => {
    await withOpenClawIdGateway(async (port) => {
      const ws = await openWs(port, { origin: "https://evil.example.test" });
      try {
        const res = await connectReq(ws, { client: TEST_OPERATOR_CLIENT, device: null });
        expect(res.ok).toBe(false);
        expect((res.error?.details as { code?: string } | undefined)?.code).toBe(
          ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED,
        );
      } finally {
        ws.close();
      }
    });
  });

  test("refuses a proxied connection from loopback at the upgrade", async () => {
    await withOpenClawIdGateway(async (port) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { "x-forwarded-for": "192.168.1.20" },
      });
      ws.on("error", () => {});
      const outcome = await new Promise<number | "open">((resolve) => {
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
        ws.on("open", () => resolve("open"));
      });
      ws.terminate();
      expect(outcome).toBe(403);
    });
  });

  test("keeps the issuer's redirect on loopback for the direct-loopback operator", async () => {
    await withOpenClawIdGateway(async (port) => {
      const ws = await openWs(port);
      try {
        await connectOk(ws, { client: TEST_OPERATOR_CLIENT });
        for (const redirectUri of [
          "http://192.168.1.20:18789/openclaw-id/callback",
          "https://studio-k7x2q.crabd.xyz/openclaw-id/callback",
        ]) {
          expect(await beginSignIn(ws, redirectUri)).toBe("malformed");
        }
      } finally {
        ws.close();
      }
    });
  });

  test.each([
    [
      "relayed by the tunnel",
      { isLocalClient: true, openclawIdPeerKey: `iroh:${"cd".repeat(32)}` },
    ],
    ["on the LAN", {}],
  ])("refuses a client %s", async (_name, internal) => {
    let refusal: string | undefined;
    await openclawIdHandlers["openclawId.authority"]!({
      params: { action: "account_begin", redirectUri: LOOPBACK_REDIRECT },
      client: { internal },
      respond: (_ok: boolean, _payload: unknown, error?: { details?: { code?: string } }) => {
        refusal = error?.details?.code;
      },
      context: {
        openclawIdService: {},
        getRuntimeConfig: () => ({ gateway: { openclawId: OPENCLAW_ID } }),
      },
    } as unknown as GatewayRequestHandlerOptions);
    expect(refusal).toBe("not_local_operator");
  });
});

describe("OpenClaw ID sign-in over a personal sign-in", () => {
  test("reaches the account method with read scope, while authority writes need admin", async () => {
    await withOpenClawIdGateway(async (port) => {
      const ws = await openWs(port);
      try {
        await connectOk(ws, { client: TEST_OPERATOR_CLIENT, scopes: ["operator.read"] });
        // Dispatch admits the read-only connection; the handler then refuses loopback.
        const account = await rpcReq(ws, "openclawId.account", { action: "device_begin" });
        expect((account.error?.details as { code?: string } | undefined)?.code).toBe(
          "not_personal_connection",
        );
        const authority = await rpcReq(ws, "openclawId.authority", { action: "account_begin" });
        expect(authority.ok).toBe(false);
        expect((authority.error?.details as { code?: string } | undefined)?.code).toBe(
          "MISSING_SCOPE",
        );
      } finally {
        ws.close();
      }
    });
  });

  test.each([
    ["the direct-loopback operator", { internal: { isLocalClient: true } }, "popup"],
    ["a verified personal profile", personal, "device"],
    [
      "a shared token or password (the shared owner profile)",
      { ...personal, authenticatedUserProfile: { profileId: GATEWAY_OWNER_PROFILE_ID } },
      null,
    ],
    ["a connection without a profile", { ...personal, authenticatedUserProfile: undefined }, null],
    [
      "an OpenClaw ID member over the tunnel",
      {
        ...personal,
        internal: { ...personal.internal, openclawIdPeerKey: `iroh:${"ab".repeat(32)}` },
      },
      null,
    ],
    [
      "a host-bound remote ingress grant",
      { ...personal, internal: { ...personal.internal, remoteIngressPrincipal: {} } },
      null,
    ],
    ["a node", { ...personal, connect: { role: "node" } }, null],
  ])("routes %s", (_name, client, route) => {
    expect(resolveOpenClawIdSignInRoute(client as never)).toBe(route);
  });

  test("starts a device sign-in only for a personal connection, never the loopback popup", async () => {
    // The gate passes, then the unconfigured issuer refuses: no request leaves the Gateway.
    const unconfigured = { enabled: true };
    expect(
      await authorityRefusal(
        personal,
        { action: "device_begin" },
        unconfigured,
        "openclawId.account",
      ),
    ).toBe("unconfigured");
    for (const client of [
      { ...personal, authenticatedUserProfile: { profileId: GATEWAY_OWNER_PROFILE_ID } },
      {
        ...personal,
        internal: { ...personal.internal, openclawIdPeerKey: `iroh:${"ab".repeat(32)}` },
      },
      { internal: { isLocalClient: true } },
      { internal: {} },
    ]) {
      for (const action of ["device_begin", "device_poll"]) {
        expect(await authorityRefusal(client, { action }, OPENCLAW_ID, "openclawId.account")).toBe(
          "not_personal_connection",
        );
      }
    }
    // A personal connection cannot use the loopback popup or get a Discovery link code.
    for (const action of ["account_begin", "account_complete", "account_link_code"]) {
      expect(await authorityRefusal(personal, { action, redirectUri: LOOPBACK_REDIRECT })).toBe(
        "not_local_operator",
      );
    }
  });

  test("is unavailable while the OpenClaw ID Labs switch is off", async () => {
    let error: { code?: string; message?: string } | undefined;
    await openclawIdHandlers["openclawId.account"]!({
      params: { action: "device_begin" },
      client: personal,
      respond: (_ok: boolean, _payload: unknown, shape?: { code?: string; message?: string }) => {
        error = shape;
      },
      context: {
        openclawIdService: {},
        getRuntimeConfig: () => ({ gateway: { openclawId: { ...OPENCLAW_ID, enabled: false } } }),
      },
    } as unknown as GatewayRequestHandlerOptions);
    expect(error?.message).toBe("OpenClaw ID is off");
  });
});
