import { appendFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { expect } from "vitest";
import { dispatchGatewayMethod } from "../../plugin-sdk/gateway-method-runtime.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import type { PluginHttpRouteRegistration } from "../../plugins/registry.js";
import { authorizeControlUiPluginCookieRequest } from "../http-auth-plugin-cookie.js";
import type { createGatewayPluginRequestHandler } from "./plugins-http.js";

export type SessionReadMethod =
  | "sessions.list"
  | "sessions.describe"
  | "sessions.get"
  | "sessions.preview"
  | "chat.history";
export type DispatchResult = Awaited<ReturnType<typeof dispatchGatewayMethod>>;
type PluginRequestHandler = ReturnType<typeof createGatewayPluginRequestHandler>;
type AuthContext = NonNullable<Parameters<PluginRequestHandler>[3]>;

/** Real socket reads and the existing held-readiness transport share the same route and cookie auth. */
export function createCookieSessionReadDispatch(params: {
  path: string;
  cookie: string;
  roles: boolean;
  sourcePolicy: boolean;
  realHttp: boolean;
  createHandler: (handler: PluginHttpRouteRegistration["handler"]) => PluginRequestHandler;
  dispatchInProcess: (
    handler: PluginRequestHandler,
    req: IncomingMessage,
    auth: AuthContext,
  ) => Promise<{ handled: boolean; res: { statusCode: number } }>;
}) {
  const { cookie, roles, sourcePolicy, realHttp, path: SECURE_HOOK_PATH } = params;
  return async (method: SessionReadMethod, key = "agent:main:shared") => {
    let result: DispatchResult | undefined;
    const handler = params.createHandler(async () => {
      result = await dispatchGatewayMethod(
        method,
        method === "sessions.list"
          ? {}
          : method === "sessions.preview"
            ? { keys: [key] }
            : method === "chat.history"
              ? { sessionKey: key }
              : { key },
      );
      return true;
    });
    if (!realHttp) {
      const req = {
        method: "GET",
        url: SECURE_HOOK_PATH,
        headers: { cookie },
      } as IncomingMessage;
      const authorized = authorizeControlUiPluginCookieRequest(req, {
        requestPath: SECURE_HOOK_PATH,
        authGeneration: "http-generation",
      });
      expect(authorized).not.toBeNull();
      const response = await params.dispatchInProcess(handler, req, {
        gatewayAuthSatisfied: true,
        gatewayRequestAuth: authorized!.requestAuth,
        gatewayRequestOperatorScopes: authorized!.operatorScopes,
      });
      expect(response.handled).toBe(true);
      return { statusCode: response.res.statusCode, result };
    }
    let statusCode = 0;
    await withServer(
      (req, res) => {
        const authorized = authorizeControlUiPluginCookieRequest(req, {
          requestPath: SECURE_HOOK_PATH,
          authGeneration: "http-generation",
        });
        expect(authorized).not.toBeNull();
        void handler(req, res, undefined, {
          gatewayAuthSatisfied: true,
          gatewayRequestAuth: authorized!.requestAuth,
          gatewayRequestOperatorScopes: authorized!.operatorScopes,
        })
          .then(() => {
            if (!res.writableEnded) {
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(result));
            }
          })
          .catch((error: unknown) => res.destroy(error instanceof Error ? error : undefined));
      },
      async (url) => {
        const response = await fetch(url + SECURE_HOOK_PATH, { headers: { cookie } });
        statusCode = response.status;
        result = response.ok ? ((await response.json()) as DispatchResult) : undefined;
      },
    );
    const trace = process.env.OPENCLAW_TEST_LEGACY_DIRECT_TRACE_PATH;
    if (trace) {
      const payload = result?.payload as
        | {
            session?: { key: string; sharingRole: string } | null;
            sessions?: Array<{ key: string }>;
          }
        | undefined;
      appendFileSync(
        trace,
        JSON.stringify({
          UTC: new Date().toISOString(),
          roles,
          sourcePolicy,
          method,
          key,
          statusCode,
          ok: result?.ok,
          session: payload?.session && {
            key: payload.session.key,
            sharingRole: payload.session.sharingRole,
          },
          discoveryKeys: payload?.sessions?.map((row) => row.key),
          error: result?.error?.code,
        }) + "\n",
      );
    }
    return { statusCode, result };
  };
}
