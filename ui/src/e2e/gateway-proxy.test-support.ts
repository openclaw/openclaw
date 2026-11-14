import { createServer, type ProxyOptions } from "vite";
import type { GatewayOperatorRolesConfig } from "../../../src/config/types.gateway.ts";
import type { OperatorScope } from "../../../src/gateway/operator-scopes.ts";

export function createPermissionGatewayConfig(options: {
  port: number;
  workspaceDir: string;
  uiBaseUrl: string;
  users: string[];
  scopes: OperatorScope[];
  roles: GatewayOperatorRolesConfig;
}) {
  const trustedProxy = {
    allowLoopback: true,
    allowUsers: options.users,
    deviceAutoApprove: { enabled: true, scopes: options.scopes },
    requiredHeaders: ["x-forwarded-proto"],
    userHeader: "x-forwarded-user",
  };
  const config = {
    agents: {
      ownership: "explicit",
      defaults: {
        workspace: options.workspaceDir,
        model: "fixture/echo",
        modelPolicy: { allow: ["fixture/echo"] },
      },
      entries: { main: {} },
    },
    models: {
      catalogRefresh: { enabled: false },
      providers: {
        fixture: {
          api: "openai-responses",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "synthetic-fixture-key",
          models: [{ id: "echo", name: "Fixture model" }],
        },
      },
    },
    gateway: {
      port: options.port,
      auth: { mode: "trusted-proxy", trustedProxy },
      trustedProxies: ["127.0.0.1", "::1"],
      controlUi: { enabled: false, allowedOrigins: [new URL(options.uiBaseUrl).origin] },
      roles: options.roles,
    },
  };
  return { config, trustedProxy };
}

export function createGatewayProxy(root: string, proxy: Record<string, ProxyOptions>) {
  return createServer({
    configFile: false,
    envFile: false,
    root,
    appType: "custom",
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, proxy },
  });
}

export function gatewayProxyRoute(port: number, user: string, forwardedFor = "192.0.2.10") {
  return {
    target: `http://127.0.0.1:${port}`,
    ws: true,
    headers: {
      "x-forwarded-for": forwardedFor,
      "x-forwarded-proto": "http",
      "x-forwarded-user": user,
    },
  };
}
