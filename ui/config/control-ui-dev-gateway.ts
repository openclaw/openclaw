import type { ProxyOptions } from "vite";
import type { ControlUiDevGateway } from "../src/dev-gateway.ts";

/** Vite owns transport; the Gateway still owns authentication and route policy. */
export function createControlUiDevGateway(
  target: string | undefined,
): { gateway: ControlUiDevGateway; proxy: Record<string, ProxyOptions> } | undefined {
  if (!target?.trim()) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(target.trim());
  } catch {
    throw new Error(
      "OPENCLAW_UI_DEV_GATEWAY_URL must be an absolute HTTP(S) or WS(S) Gateway URL.",
    );
  }
  if (
    !["http:", "https:", "ws:", "wss:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "OPENCLAW_UI_DEV_GATEWAY_URL must not contain credentials, a query, or a fragment.",
    );
  }
  url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:";
  const gatewayUrl = url.href.replace(/\/$/u, "");
  // A retired page cannot send credentials to a replacement upstream on the same Vite port.
  const proxyPath = `/__openclaw_dev_gateway__/${encodeURIComponent(gatewayUrl)}`;
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return {
    gateway: { gatewayUrl, proxyPath },
    proxy: {
      [`${proxyPath}/`]: {
        target: url.origin,
        changeOrigin: true,
        ws: true,
        rewrite: (requestPath) => requestPath.slice(proxyPath.length),
        cookieDomainRewrite: "",
        configure(proxy) {
          proxy.on("proxyRes", (response) => {
            const cookies = response.headers["set-cookie"];
            if (cookies) {
              response.headers["set-cookie"] = cookies.map((cookie) =>
                cookie.replace(
                  /(;\s*path=)(\/[^;]*)/iu,
                  (_match, attribute: string, value: string) => `${attribute}${proxyPath}${value}`,
                ),
              );
            }
          });
        },
      },
    },
  };
}
