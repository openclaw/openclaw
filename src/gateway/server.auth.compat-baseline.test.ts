import { beforeAll, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { issueOperatorToken } from "./device-authz.test-helpers.js";
import {
  BACKEND_GATEWAY_CLIENT,
  connectReq,
  ConnectErrorDetailCodes,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  openWs,
  originForPort,
  rpcReq,
  restoreGatewayToken,
  startTestGatewayServer,
  testState,
  installGatewayTestHooks,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const CLI_CLIENT = {
  id: GATEWAY_CLIENT_NAMES.CLI,
  version: "1.0.0",
  platform: "test",
  mode: GATEWAY_CLIENT_MODES.CLI,
};

async function withSocket(
  port: number,
  origin: string | undefined,
  run: (ws: WebSocket) => Promise<void>,
) {
  const ws = await openWs(port, origin ? { origin } : undefined);
  try {
    await run(ws);
  } finally {
    ws.close();
  }
}

async function expectLocalSharedAuthScopesPreserved(
  port: number,
  auth: { token?: string; password?: string; skipDefaultAuth?: boolean },
  client: typeof BACKEND_GATEWAY_CLIENT | typeof CLI_CLIENT,
) {
  await withSocket(port, undefined, async (ws) => {
    const res = await connectReq(ws, {
      ...auth,
      client,
      scopes: ["operator.admin"],
      device: null,
    });
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(res.payload).toHaveProperty("auth.scopes", ["operator.admin"]);
    expect((await rpcReq(ws, "exec.approvals.get", {})).ok).toBe(true);
  });
}

function useGateway(auth: GatewayAuthConfig, controlUiEnabled?: boolean) {
  const gateway = { port: 0 };
  beforeAll(async () => {
    const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    testState.gatewayAuth = auth;
    restoreGatewayToken(auth.mode === "token" ? "secret" : undefined);
    const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    gateway.port = claim.port;
    const server = await startTestGatewayServer(claim, { controlUiEnabled });
    return async () => {
      await server.close();
      restoreGatewayToken(previousToken);
    };
  });
  return gateway;
}

describe("gateway auth compatibility baseline", () => {
  describe("token mode", () => {
    const gateway = useGateway({ mode: "token", token: "secret" });

    test.each([BACKEND_GATEWAY_CLIENT, CLI_CLIENT])(
      "preserves scopes for direct-local $id shared-token connects without device identity",
      async (client) => {
        await expectLocalSharedAuthScopesPreserved(gateway.port, { token: "secret" }, client);
      },
    );

    test("keeps local backend device-token reconnects out of pairing", async () => {
      const { identityPath, token: deviceToken } = await issueOperatorToken({
        name: "backend-device",
        clientId: BACKEND_GATEWAY_CLIENT.id,
        clientMode: BACKEND_GATEWAY_CLIENT.mode,
        approvedScopes: ["operator.admin"],
        tokenScopes: ["operator.admin"],
      });
      expect(deviceToken).toBeTypeOf("string");
      expect(deviceToken.length).toBeGreaterThan(0);

      await withSocket(gateway.port, undefined, async (ws) => {
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          client: { ...BACKEND_GATEWAY_CLIENT },
          deviceIdentityPath: identityPath,
          deviceToken,
          scopes: ["operator.admin"],
        });
        expect(res).toMatchObject({
          ok: true,
          payload: {
            type: "hello-ok",
            snapshot: {
              configPath: expect.stringMatching(/./),
              stateDir: expect.stringMatching(/./),
              authMode: "token",
            },
          },
        });
      });
    });
  });

  describe("none mode", () => {
    const gateway = useGateway({ mode: "none" }, true);

    test("allows auth-none local backend connects without device identity", async () => {
      await expectLocalSharedAuthScopesPreserved(
        gateway.port,
        { skipDefaultAuth: true },
        BACKEND_GATEWAY_CLIENT,
      );
    });

    test("rejects auth-none browser-origin backend connects without device identity", async () => {
      await withSocket(gateway.port, originForPort(gateway.port), async (ws) => {
        const res = await connectReq(ws, {
          skipDefaultAuth: true,
          client: { ...BACKEND_GATEWAY_CLIENT },
          scopes: ["operator.admin"],
          device: null,
        });
        expect(res).toMatchObject({
          ok: false,
          error: {
            message: expect.stringContaining("device identity required"),
            details: { code: ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED },
          },
        });
      });
    });
  });
});
