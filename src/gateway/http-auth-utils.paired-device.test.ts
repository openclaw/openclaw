import fs from "node:fs";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import * as deviceTokens from "../infra/device-pairing-tokens.js";
import { requestDevicePairing } from "../infra/device-pairing.js";
import { readJsonBodyWithLimit } from "../infra/http-body.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE } from "./control-ui-bootstrap-contract.js";
import { handleControlUiHttpRequest } from "./control-ui.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import {
  AUTH_TOKEN,
  createRequest,
  createResponse,
  dispatchRequest,
  sendRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";
import { createGatewayTestRegistry } from "./server/__tests__/test-utils.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";
import { makeMockHttpResponse } from "./test-http-response.js";

it.each(["operator.admin", "operator.read"])(
  "createGatewayHttpServer plugin PUT/POST revalidates paired %s authority after reading the body",
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
      const token = await deviceTokens.ensureDeviceToken({
        deviceId: "browser",
        role: "operator",
        scopes,
        issuer: {
          kind: "shared-gateway-auth",
          generation: resolveSharedGatewaySessionGeneration(AUTH_TOKEN, [])!,
        },
      });
      expect(token).not.toBeNull();
      const bodyStarted = createDeferred();
      let effects = 0;
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
              handler: async (req, res) => {
                const runtime = getPluginRuntimeGatewayRequestScope();
                const granted = runtime?.client?.connect.scopes ?? [];
                if (req.headers["content-type"] === "application/json") {
                  const body = readJsonBodyWithLimit(req, { maxBytes: 1024 });
                  bodyStarted.resolve();
                  expect((await body).ok).toBe(true);
                }
                await runtime?.revalidate?.();
                const allowed = authorizeOperatorScopesForMethod("set-heartbeats", granted).allowed;
                if (allowed) {
                  effects += 1;
                }
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
          const pending = createRequest({
            path: "/profile",
            method: "PUT",
            authorization: `Bearer ${token!.token}`,
            headers: { "content-type": "application/json" },
          });
          const response = createResponse();
          Object.defineProperty(response.res, "writableEnded", {
            get: () => response.res.writableFinished,
          });
          const dispatch = dispatchRequest(server, pending, response.res);
          await bodyStarted.promise;
          const previousEffects = effects;
          await deviceTokens.revokeDeviceToken({ deviceId: "browser", role: "operator" });
          pending.emit("data", Buffer.from("{}"));
          pending.emit("end");
          await dispatch;
          expect(response.res.statusCode).toBe(401);
          expect(JSON.parse(response.getBody())).toEqual({
            error: { message: "Unauthorized", type: "unauthorized" },
          });
          expect(effects).toBe(previousEffects);
          for (const credential of [token!.token, "wrong-token"]) {
            const rejected = await sendRequest(server, {
              path: "/profile",
              method: "PUT",
              authorization: `Bearer ${credential}`,
            });
            expect(rejected.res.statusCode).toBe(401);
            expect(JSON.parse(rejected.getBody())).toEqual({
              error: { message: "Unauthorized", type: "unauthorized" },
            });
          }
        },
      });
    });
  },
);

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("keeps the public shell when a paired token is revoked during bootstrap admission", async () => {
  await withOpenClawTestState({ label: "bootstrap-revoked-device" }, async () => {
    const root = dirs.make("bootstrap-revoked-device-");
    fs.writeFileSync(
      join(root, "index.html"),
      "<!doctype html><html><head></head><body><openclaw-app></openclaw-app></body></html>",
    );
    const auth = { mode: "token" as const, token: "synthetic-shared-token", allowTailscale: false };
    const scopes = ["operator.read"];
    const pairing = await requestDevicePairing({
      deviceId: "bootstrap-browser",
      publicKey: "synthetic-public-key",
      role: "operator",
      scopes,
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
    });
    await approveDevicePairing(pairing.request.requestId, { callerScopes: scopes });
    const token = await deviceTokens.ensureDeviceToken({
      deviceId: "bootstrap-browser",
      role: "operator",
      scopes,
      issuer: {
        kind: "shared-gateway-auth",
        generation: resolveSharedGatewaySessionGeneration(auth, [])!,
      },
    });
    expect(token).not.toBeNull();
    const verify = deviceTokens.verifyDeviceToken;
    vi.spyOn(deviceTokens, "verifyDeviceToken").mockImplementationOnce(async (params) => {
      const result = await verify(params);
      await deviceTokens.revokeDeviceToken({ deviceId: "bootstrap-browser", role: "operator" });
      return result;
    });

    const req = new IncomingMessage(new Socket());
    req.url = "/control/chat/main/topic";
    req.method = "GET";
    req.headers = { authorization: `Bearer ${token!.token}` };
    const response = makeMockHttpResponse();
    const config: OpenClawConfig = {};
    await handleControlUiHttpRequest(req, response.res, {
      basePath: "/control",
      root: { kind: "resolved", path: root },
      config,
      getRuntimeConfig: () => config,
      auth,
      sessionEntryPath: req.url,
      isSessionEntryCurrent: () => true,
    });
    expect(response.res.statusCode).toBe(200);
    const body = String(response.end.mock.calls[0]?.[0] ?? "");
    expect(body).toContain("<openclaw-app");
    expect(body).not.toContain(CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE);
  });
});
