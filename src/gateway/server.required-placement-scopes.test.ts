import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { HelloOk } from "../../packages/gateway-protocol/src/schema/frames.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { writeConfigFile } from "../config/config.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import {
  connectReq,
  CONTROL_UI_CLIENT,
  installGatewayTestHooks,
  openWs,
  rpcReq,
  testState,
  withGatewayServer,
} from "./server.auth.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
const temps = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

test.each([false, true])(
  "session writers read only requested placement policy over authenticated RPC (required=%s)",
  async (required) => {
    const origin = "https://control.example.invalid";
    const email = "writer@example.invalid";
    const auth: GatewayAuthConfig = {
      mode: "trusted-proxy",
      identityScopes: { [email]: ["operator.sessions.write"] },
      trustedProxy: {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowLoopback: true,
        allowUsers: [email],
      },
    };
    testState.gatewayAuth = auth;
    testState.gatewayControlUi = { allowedOrigins: [origin] };
    await writeConfigFile({
      gateway: { auth, trustedProxies: ["127.0.0.1"], controlUi: { allowedOrigins: [origin] } },
      ...(required
        ? {
            cloudWorkers: {
              requiredProfile: "dedicated",
              profiles: {
                dedicated: {
                  provider: "device",
                  settings: { device: "paired", inference: "worker" },
                },
              },
            },
          }
        : {}),
    });
    if (required) {
      vi.stubEnv("OPENCLAW_TEST_MINIMAL_GATEWAY", "0");
    }
    await withGatewayServer(async ({ port }) => {
      const ws = await openWs(port, {
        origin,
        "x-forwarded-user": email,
        "x-forwarded-for": "203.0.113.50",
        "x-forwarded-proto": "https",
      });
      try {
        const connected = await connectReq(ws, {
          prePairDevice: true,
          client: CONTROL_UI_CLIENT,
          browserOrigin: origin,
          skipDefaultAuth: true,
          scopes: ["operator.sessions.write"],
          deviceIdentityPath: path.join(temps.make("policy-writer-"), "device.sqlite"),
        });
        expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
        expect((connected.payload as HelloOk).auth.scopes).not.toContain("operator.write");
        const self = await rpcReq<{ profile: { id: string } }>(ws, "users.self", {});
        expect(self.ok, JSON.stringify(self.error)).toBe(true);
        expect(self.payload?.profile.id).toBeTruthy();
        for (const params of [{}, { runtimeId: "openclaw" }]) {
          const inventory = await rpcReq(ws, "environments.list", params);
          expect(inventory.ok).toBe(false);
          expect(inventory.error?.message).toMatch(/missing scope/);
        }
        const listed = await rpcReq<{ sessionPlacement: unknown }>(ws, "agents.list", {
          includeSessionPlacement: true,
        });
        expect(listed.ok, JSON.stringify(listed.error)).toBe(true);
        expect(listed.payload?.sessionPlacement).toEqual(
          required
            ? {
                requiredProfile: {
                  id: "dedicated",
                  providerId: "device",
                  executionModes: ["worker-turn"],
                  inference: "worker",
                },
              }
            : {},
        );
        const ordinary = await rpcReq(ws, "agents.list", {});
        expect(ordinary.ok).toBe(true);
        expect(ordinary.payload).not.toHaveProperty("sessionPlacement");
      } finally {
        ws.close();
      }
    });
  },
);
