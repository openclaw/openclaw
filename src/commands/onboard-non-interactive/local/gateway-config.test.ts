import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { RuntimeEnv } from "../../../runtime.js";
import type { OnboardOptions } from "../../onboard-types.js";
import { applyNonInteractiveGatewayConfig } from "./gateway-config.js";

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
} as unknown as RuntimeEnv;

function makeOpts(overrides: Partial<OnboardOptions> = {}): OnboardOptions {
  return {
    nonInteractive: true,
    mode: "local",
    gatewayBind: "loopback",
    gatewayAuth: "token",
    gatewayToken: "test-token",
    ...overrides,
  } as OnboardOptions;
}

describe("applyNonInteractiveGatewayConfig", () => {
  it("preserves existing gateway.mode from nextConfig", () => {
    const nextConfig: OpenClawConfig = {
      gateway: { mode: "local" },
    };
    const result = applyNonInteractiveGatewayConfig({
      nextConfig,
      opts: makeOpts(),
      runtime,
      defaultPort: 18789,
    });
    expect(result?.nextConfig.gateway?.mode).toBe("local");
  });

  it("defaults gateway.mode to local when nextConfig has no mode (#10767)", () => {
    // Simulates the bug: gateway object exists (e.g. with auth) but mode is missing
    const nextConfig: OpenClawConfig = {
      gateway: {
        auth: { mode: "token", token: "existing-token" },
      },
    };
    const result = applyNonInteractiveGatewayConfig({
      nextConfig,
      opts: makeOpts(),
      runtime,
      defaultPort: 18789,
    });
    expect(result?.nextConfig.gateway?.mode).toBe("local");
  });

  it("defaults gateway.mode to local when nextConfig.gateway is undefined", () => {
    const nextConfig: OpenClawConfig = {};
    const result = applyNonInteractiveGatewayConfig({
      nextConfig,
      opts: makeOpts(),
      runtime,
      defaultPort: 18789,
    });
    expect(result?.nextConfig.gateway?.mode).toBe("local");
  });

  it("does not override an explicitly set remote mode", () => {
    const nextConfig: OpenClawConfig = {
      gateway: { mode: "remote" },
    };
    const result = applyNonInteractiveGatewayConfig({
      nextConfig,
      opts: makeOpts(),
      runtime,
      defaultPort: 18789,
    });
    expect(result?.nextConfig.gateway?.mode).toBe("remote");
  });
});
