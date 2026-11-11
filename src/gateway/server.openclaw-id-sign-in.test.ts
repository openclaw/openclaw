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
