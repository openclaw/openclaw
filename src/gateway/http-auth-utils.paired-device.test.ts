import fs from "node:fs";
import { ServerResponse } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
import { readStoredClaw, writeStoredClaw } from "./openclaw-id/claw-store.js";
import {
  setDeviceTokenBindingOwner,
  setDeviceTokenBindingsLoading,
} from "./openclaw-id/device-token-binding.js";
import { linkedClaw } from "./openclaw-id/openclaw-id.test-support.js";
import { createOpenClawIdService } from "./openclaw-id/service.js";
import { setOpenClawIdTunnelPrincipalResolver } from "./openclaw-id/tunnel-principal.js";
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

function profileRequest(token: string, method = "PUT", headers: Record<string, string> = {}) {
  return { path: "/profile", method, authorization: `Bearer ${token}`, headers };
}

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
            const response = await sendRequest(
              server,
              profileRequest(token, method, { "x-openclaw-scopes": "operator.admin" }),
            );
            expect(response.res.statusCode).toBe(isAdmin ? 200 : 403);
            expect(JSON.parse(response.getBody())).toEqual({ scopes: expectedScopes });
          }
          const pending = createRequest(
            profileRequest(token, "PUT", { "content-type": "application/json" }),
          );
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
            const rejected = await sendRequest(server, profileRequest(credential));
            expectUnauthorized(rejected);
          }
        },
      });
    });
  },
);

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  setDeviceTokenBindingOwner(undefined);
  setDeviceTokenBindingsLoading(Promise.resolve());
  setOpenClawIdTunnelPrincipalResolver(undefined);
});

// Status of an ordinary-ingress Control UI read with `token`, or null when authorized.
async function ordinaryReadStatus(token: string): Promise<number | null> {
  const req = createRequest({ path: "/control-ui-config.json", authorization: `Bearer ${token}` });
  const res = new ServerResponse(req);
  try {
    const authorized = await authorizeControlUiReadRequestOrReply({
      req,
      res,
      auth: AUTH_TOKEN,
      cfg: {},
      getRuntimeConfig: () => ({}),
    });
    return authorized ? null : res.statusCode;
  } finally {
    res.destroy();
    req.destroy();
  }
}

it.each(["operator.read.no-credential-enrollment", "operator.write.no-credential-enrollment"])(
  "preserves a paired device grant on Control UI reads with %s",
  async (scope) => {
    await withOpenClawTestState({ label: "bounded-http-device-read" }, async () => {
      const token = await pairBrowser([scope]);
      const req = createRequest({
        path: "/control-ui-config.json",
        authorization: `Bearer ${token}`,
      });
      const res = new ServerResponse(req);
      try {
        const result = await authorizeControlUiReadRequestOrReply({
          req,
          res,
          auth: AUTH_TOKEN,
          cfg: {},
          getResolvedAuth: () => AUTH_TOKEN,
          getRuntimeConfig: () => ({}),
        });
        expect(result?.operatorScopes).toEqual([scope]);
      } finally {
        res.destroy();
      }
    });
  },
);

it("keeps a saved tunnel-bound token refused on HTTP after a Gateway start with the switch off", async () => {
  await withOpenClawTestState({ label: "openclaw-id-http-restart-off" }, async () => {
    const token = await pairBrowser(["operator.admin"]);
    const claw = await linkedClaw({ read: readStoredClaw, write: writeStoredClaw });
    await claw.authority.bindToken("browser", "operator", claw.w1);
    // A new service over the saved claw record stands for the restarted Gateway.
    const service = createOpenClawIdService({
      getConfig: () => ({ enabled: false }),
      getStateDir: () => "/nonexistent/openclaw-id-test",
      getGatewayServer: () => undefined,
      log: { info: () => {}, warn: () => {} },
    });
    const loaded = service.loadTokenBindings();
    const early = ordinaryReadStatus(token);
    await loaded;
    expect(await early).toBe(401);
    expect(await ordinaryReadStatus(token)).toBe(401);
    await service.stop();
  });
});

it("refuses tunnel-bound HTTP tokens outside the tunnel and token fallback for removed peers", async () => {
  await withOpenClawTestState({ label: "openclaw-id-http-binding" }, async () => {
    const token = await pairBrowser(["operator.admin"]);
    const peerKey = `iroh:${"ac".repeat(32)}`;
    setDeviceTokenBindingOwner({
      lookup: () => peerKey,
      record: async () => {},
      reportMismatch: () => {},
    });
    setOpenClawIdTunnelPrincipalResolver(async () => undefined);
    for (const tunnel of [false, true]) {
      const req = createRequest({
        path: "/control-ui-config.json",
        authorization: `Bearer ${token}`,
      });
      if (tunnel) {
        markGatewayIngressTransport(req, {
          kind: "openclaw-id-tunnel",
          peerKey,
          clientIp: "fd69:726f:6800::1",
        });
      }
      const res = new ServerResponse(req);
      try {
        expect(
          await authorizeControlUiReadRequestOrReply({
            req,
            res,
            auth: AUTH_TOKEN,
            cfg: {},
            getRuntimeConfig: () => ({}),
          }),
        ).toBeNull();
        expect(res.statusCode).toBe(401);
      } finally {
        res.destroy();
        req.destroy();
      }
    }
  });
});

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
    const token = await pairBrowser(["operator.read"]);
    const verify = deviceTokens.verifyDeviceToken;
    vi.spyOn(deviceTokens, "verifyDeviceToken").mockImplementationOnce(async (params) => {
      const result = await verify(params);
      await deviceTokens.revokeDeviceToken({ deviceId: "browser", role: "operator" });
      return result;
    });

    const req = createRequest({
      path: "/control/chat/main/topic",
      authorization: `Bearer ${token}`,
    });
    const response = makeMockHttpResponse();
    await handleControlUiHttpRequest(req, response.res, {
      basePath: "/control",
      root: { kind: "resolved", path: root },
      config: {},
      getRuntimeConfig: () => ({}),
      auth: AUTH_TOKEN,
      sessionEntryPath: req.url,
      isSessionEntryCurrent: () => true,
    });
    expect(response.res.statusCode).toBe(200);
    const body = String(response.end.mock.calls[0]?.[0] ?? "");
    expect(body).toContain("<openclaw-app");
    expect(body).not.toContain(CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE);
  });
});
