import { expect, it } from "vitest";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { ensureDeviceToken, revokeDeviceToken } from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { AUTH_TOKEN, sendRequest, withGatewayServer } from "./server-http.test-harness.js";
import { createGatewayTestRegistry } from "./server/__tests__/test-utils.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

it.each(["operator.admin", "operator.read"])(
  "createGatewayHttpServer plugin PUT/POST preserves paired %s authority and revocation",
  async (scope) => {
    await withOpenClawTestState({ label: "plugin-device-auth" }, async () => {
      const scopes = [scope];
      const requested = await requestDevicePairing({
        deviceId: "browser",
        publicKey: "fixture-key",
        role: "operator",
        scopes,
        clientId: "openclaw-control-ui",
        clientMode: "webchat",
      });
      await approveDevicePairing(requested.request.requestId, { callerScopes: scopes });
      const token = await ensureDeviceToken({
        deviceId: "browser",
        role: "operator",
        scopes,
        issuer: {
          kind: "shared-gateway-auth",
          generation: resolveSharedGatewaySessionGeneration(AUTH_TOKEN, [])!,
        },
      });
      expect(token).not.toBeNull();
      const handlePluginRequest = createGatewayPluginRequestHandler({
        registry: createGatewayTestRegistry({
          httpRoutes: [
            {
              pluginId: "profile",
              source: "fixture",
              path: "/profile",
              match: "exact",
              auth: "gateway",
              gatewayRuntimeScopeSurface: "trusted-operator",
              handler: async (_req, res) => {
                const granted = getPluginRuntimeGatewayRequestScope()?.client?.connect.scopes ?? [];
                const allowed = authorizeOperatorScopesForMethod("set-heartbeats", granted).allowed;
                res.statusCode = allowed ? 200 : 403;
                res.end(JSON.stringify({ scopes: granted }));
                return true;
              },
            },
          ],
        }),
        log: createSubsystemLogger("test/plugin-device-auth"),
      });
      await withGatewayServer({
        prefix: "plugin-device-auth-",
        resolvedAuth: AUTH_TOKEN,
        overrides: {
          handlePluginRequest,
          shouldEnforcePluginGatewayAuth: (path) => path.pathname === "/profile",
        },
        run: async (server) => {
          for (const method of ["PUT", "POST"]) {
            const response = await sendRequest(server, {
              path: "/profile",
              method,
              authorization: `Bearer ${token!.token}`,
              headers: { "x-openclaw-scopes": "operator.admin" },
            });
            expect(response.res.statusCode).toBe(scope === "operator.admin" ? 200 : 403);
            expect(JSON.parse(response.getBody())).toEqual({
              scopes:
                scope === "operator.admin"
                  ? ["operator.admin", "operator.read", "operator.write"]
                  : ["operator.read"],
            });
          }
          await revokeDeviceToken({ deviceId: "browser", role: "operator" });
          for (const credential of [token!.token, "wrong-token"]) {
            const response = await sendRequest(server, {
              path: "/profile",
              method: "PUT",
              authorization: `Bearer ${credential}`,
            });
            expect(response.res.statusCode).toBe(401);
            expect(JSON.parse(response.getBody())).toEqual({
              error: { message: "Unauthorized", type: "unauthorized" },
            });
          }
        },
      });
    });
  },
);
