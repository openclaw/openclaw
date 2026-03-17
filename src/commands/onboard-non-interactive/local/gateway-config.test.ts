import { describe, it, expect, vi } from "vitest";
import type { RuntimeEnv } from "../../../runtime.js";
import type { OnboardOptions } from "../../onboard-types.js";
import { applyNonInteractiveGatewayConfig } from "./gateway-config.js";

const baseConfig = {};
const defaultPort = 18789;

function makeRuntime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv;
}

describe("applyNonInteractiveGatewayConfig - trusted-proxy", () => {
  it("applies trusted-proxy settings from comma-separated flags", () => {
    const opts = {
      gatewayAuth: "trusted-proxy",
      gatewayTrustedProxies: "127.0.0.1,10.0.0.1",
      gatewayTrustedProxyUserHeader: "X-Forwarded-User",
      gatewayTrustedProxyRequiredHeaders: "x-forwarded-proto,x-forwarded-host",
      gatewayControlUiAllowedOrigins: "https://host.example.com,https://host2.example.com",
    } as unknown as OnboardOptions;
    const runtime = makeRuntime();
    const res = applyNonInteractiveGatewayConfig({
      nextConfig: baseConfig,
      opts,
      runtime,
      defaultPort,
    });
    expect(res).not.toBeNull();
    expect(res?.nextConfig.gateway).toBeDefined();
    expect(res?.nextConfig.gateway?.auth?.mode).toBe("trusted-proxy");
    expect(res?.nextConfig.gateway?.trustedProxies).toEqual(["127.0.0.1", "10.0.0.1"]);
    expect(res?.nextConfig.gateway?.auth?.trustedProxy?.userHeader).toBe("X-Forwarded-User");
    expect(res?.nextConfig.gateway?.auth?.trustedProxy?.requiredHeaders).toEqual([
      "x-forwarded-proto",
      "x-forwarded-host",
    ]);
    expect(res?.nextConfig.gateway?.controlUi?.allowedOrigins).toEqual([
      "https://host.example.com",
      "https://host2.example.com",
    ]);
  });

  it("errors when trusted-proxy selected but no proxies provided", () => {
    const opts = { gatewayAuth: "trusted-proxy" } as unknown as OnboardOptions;
    const runtime = makeRuntime();
    const res = applyNonInteractiveGatewayConfig({
      nextConfig: baseConfig,
      opts,
      runtime,
      defaultPort,
    });
    expect(res).toBeNull();
    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("applies allowUsers when provided as comma-separated", () => {
    const opts = {
      gatewayAuth: "trusted-proxy",
      gatewayTrustedProxies: "127.0.0.1",
      gatewayTrustedProxyUserHeader: "X-Forwarded-User",
      gatewayTrustedProxyAllowUsers: "admin@example.com,nick@example.com",
    } as unknown as OnboardOptions;
    const runtime = makeRuntime();
    const res = applyNonInteractiveGatewayConfig({
      nextConfig: baseConfig,
      opts,
      runtime,
      defaultPort,
    });
    expect(res).not.toBeNull();
    expect(res?.nextConfig.gateway?.auth?.trustedProxy?.allowUsers).toEqual([
      "admin@example.com",
      "nick@example.com",
    ]);
  });
});
