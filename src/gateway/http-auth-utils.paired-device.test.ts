import fs from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
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
import { authorizeControlUiReadRequestOrReply } from "./http-auth-utils.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { createRemoteControlUiIngressTestContext } from "./remote-control-ui.test-support.js";
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

async function pairBrowser(scopes: string[], auth = AUTH_TOKEN, controlUi = true) {
  const identity = { deviceId: "browser", role: "operator", scopes };
  const requested = await requestDevicePairing({
    ...identity,
    publicKey: "fixture-key",
    ...(controlUi ? { clientId: "openclaw-control-ui", clientMode: "webchat" } : {}),
  });
  await approveDevicePairing(requested.request.requestId, { callerScopes: scopes });
  const token = await deviceTokens.ensureDeviceToken({
    ...identity,
    issuer: {
      kind: "shared-gateway-auth",
      generation: resolveSharedGatewaySessionGeneration(auth, [])!,
    },
  });
  expect(token).not.toBeNull();
  return token!.token;
}

function expectUnauthorized(response: ReturnType<typeof createResponse>) {
  expect(response.res.statusCode).toBe(401);
  expect(JSON.parse(response.getBody())).toEqual({
    error: { message: "Unauthorized", type: "unauthorized" },
  });
}

it.each(["operator.admin", "operator.read"])(
  "createGatewayHttpServer plugin PUT/POST revalidates paired %s authority after reading the body",
  async (scope) => {
    await withOpenClawTestState({ label: "plugin-device-auth" }, async () => {
      const token = await pairBrowser([scope]);
      const bodyStarted = createDeferred();
      let effects = 0;
      const registry = createGatewayTestRegistry();
      registry.httpRoutes.push({
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
      });
      const handlePluginRequest = createGatewayPluginRequestHandler({
        registry,
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
          const isAdmin = scope === "operator.admin";
          const expectedScopes = isAdmin
            ? ["operator.admin", "operator.read", "operator.write"]
            : ["operator.read"];
          for (const method of ["PUT", "POST"]) {
            const response = await sendRequest(server, {
              path: "/profile",
              method,
              authorization: `Bearer ${token}`,
              headers: { "x-openclaw-scopes": "operator.admin" },
            });
            expect(response.res.statusCode).toBe(isAdmin ? 200 : 403);
            expect(JSON.parse(response.getBody())).toEqual({ scopes: expectedScopes });
          }
          const pending = createRequest({
            path: "/profile",
            method: "PUT",
            authorization: `Bearer ${token}`,
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
          expectUnauthorized(response);
          expect(effects).toBe(previousEffects);
          for (const credential of [token, "wrong-token"]) {
            const rejected = await sendRequest(server, {
              path: "/profile",
              method: "PUT",
              authorization: `Bearer ${credential}`,
            });
            expectUnauthorized(rejected);
          }
        },
      });
    });
  },
);

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("authenticates remote HTTP reads only from the grant and refuses reusable credentials", async () => {
  await withOpenClawTestState({ label: "remote-http-device-ceiling" }, async () => {
    const token = await pairBrowser(["operator.admin"], AUTH_TOKEN, false);
    for (const credential of [token, AUTH_TOKEN.token!, undefined]) {
      const req = createRequest({
        path: "/control-ui-config.json",
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        headers: { origin: "https://ui.example.test" },
        host: "ui.example.test",
      });
      markGatewayIngressTransport(req, {
        kind: "remote-forwarded",
        context: createRemoteControlUiIngressTestContext({
          operatorScopeCeiling: ["operator.read"],
          frameAncestors: [],
        }),
      });
      const res = new ServerResponse(req);
      try {
        const result = await authorizeControlUiReadRequestOrReply({
          req,
          res,
          auth: AUTH_TOKEN,
          cfg: {},
          getRuntimeConfig: () => ({}),
        });
        if (credential === undefined) {
          expect(result?.authMethod).toBe("remote-ingress");
          expect(result?.operatorScopes).toEqual(["operator.read"]);
        } else {
          expect(result).toBeNull();
          expect(res.statusCode).toBe(401);
        }
      } finally {
        res.destroy();
        req.destroy();
      }
    }
  });
});

it("keeps the public shell when a paired token is revoked during bootstrap admission", async () => {
  await withOpenClawTestState({ label: "bootstrap-revoked-device" }, async () => {
    const root = dirs.make("bootstrap-revoked-device-");
    fs.writeFileSync(
      join(root, "index.html"),
      "<!doctype html><html><head></head><body><openclaw-app></openclaw-app></body></html>",
    );
    const auth = { mode: "token" as const, token: "synthetic-shared-token", allowTailscale: false };
    const token = await pairBrowser(["operator.read"], auth);
    const verify = deviceTokens.verifyDeviceToken;
    vi.spyOn(deviceTokens, "verifyDeviceToken").mockImplementationOnce(async (params) => {
      const result = await verify(params);
      await deviceTokens.revokeDeviceToken({ deviceId: "browser", role: "operator" });
      return result;
    });

    const req = new IncomingMessage(new Socket());
    req.url = "/control/chat/main/topic";
    req.method = "GET";
    req.headers = { authorization: `Bearer ${token}` };
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
