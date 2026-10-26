import { createServer, type ProxyOptions } from "vite";

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
