import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { OnboardOptions } from "../onboard-types.js";
import { applyNonInteractiveGatewayConfig } from "./gateway-config.js";

// Narrow mock: reproduce normalize semantics (typeof-string + trim, reject
// "undefined"/"null" literals) and stub randomToken so we can assert when a
// fresh token is generated vs. reused from the resolution chain.
const randomToken = vi.hoisted(() => vi.fn(() => "generated-random-token"));
vi.mock("../../onboard-helpers.js", () => ({
  normalizeGatewayTokenInput: (value: unknown): string => {
    if (typeof value !== "string") return "";
    const trimmed = value.trim();
    if (trimmed === "undefined" || trimmed === "null") return "";
    return trimmed;
  },
  randomToken,
}));

function createRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

const baseOpts = {} as OnboardOptions;

describe("applyNonInteractiveGatewayConfig token resolution chain", () => {
  const originalEnvToken = process.env.OPENCLAW_GATEWAY_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  });

  afterEach(() => {
    if (originalEnvToken === undefined) {
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
    } else {
      process.env.OPENCLAW_GATEWAY_TOKEN = originalEnvToken;
    }
  });

  it("preserves existing gateway.auth.token when no flag or env override is provided", () => {
    const nextConfig = {
      gateway: { auth: { mode: "token", token: "existing-user-token" } },
    } as OpenClawConfig;

    const result = applyNonInteractiveGatewayConfig({
      nextConfig,
      opts: baseOpts,
      runtime: createRuntime() as never,
      defaultPort: 18789,
    });

    expect(result?.gatewayToken).toBe("existing-user-token");
    expect(result?.nextConfig.gateway?.auth?.token).toBe("existing-user-token");
    expect(randomToken).not.toHaveBeenCalled();
  });

  it("prefers --gateway-token flag over existing config token", () => {
    const nextConfig = {
      gateway: { auth: { mode: "token", token: "existing-user-token" } },
    } as OpenClawConfig;

    const result = applyNonInteractiveGatewayConfig({
      nextConfig,
      opts: { gatewayToken: "flag-token" } as OnboardOptions,
      runtime: createRuntime() as never,
      defaultPort: 18789,
    });

    expect(result?.gatewayToken).toBe("flag-token");
    expect(result?.nextConfig.gateway?.auth?.token).toBe("flag-token");
    expect(randomToken).not.toHaveBeenCalled();
  });

  it("prefers OPENCLAW_GATEWAY_TOKEN env var over existing config token", () => {
    process.env.OPENCLAW_GATEWAY_TOKEN = "env-token";
    const nextConfig = {
      gateway: { auth: { mode: "token", token: "existing-user-token" } },
    } as OpenClawConfig;

    const result = applyNonInteractiveGatewayConfig({
      nextConfig,
      opts: baseOpts,
      runtime: createRuntime() as never,
      defaultPort: 18789,
    });

    expect(result?.gatewayToken).toBe("env-token");
    expect(result?.nextConfig.gateway?.auth?.token).toBe("env-token");
    expect(randomToken).not.toHaveBeenCalled();
  });

  it("generates a random token only when flag, env, and existing config are all empty", () => {
    const result = applyNonInteractiveGatewayConfig({
      nextConfig: {} as OpenClawConfig,
      opts: baseOpts,
      runtime: createRuntime() as never,
      defaultPort: 18789,
    });

    expect(randomToken).toHaveBeenCalledOnce();
    expect(result?.gatewayToken).toBe("generated-random-token");
    expect(result?.nextConfig.gateway?.auth?.token).toBe("generated-random-token");
  });
});
