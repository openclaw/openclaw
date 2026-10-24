import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import type { OnboardOptions } from "../../onboard-types.js";
import { applyNonInteractiveGatewayConfig } from "./gateway-config.js";

const randomToken = vi.hoisted(() => vi.fn(() => "generated-random-token"));
vi.mock("../../onboard-helpers.js", () => ({
  normalizeGatewayTokenInput: (value: unknown): string => {
    if (typeof value !== "string") {
      return "";
    }
    const trimmed = value.trim();
    if (trimmed === "undefined" || trimmed === "null") {
      return "";
    }
    return trimmed;
  },
  randomToken,
}));

let runtime: ReturnType<typeof createRuntime>;
function createRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

const SAMPLE_SECRET_REF = {
  source: "env" as const,
  provider: "default",
  id: "OPENCLAW_GATEWAY_TOKEN_REF",
};

function applyGatewayConfig({
  auth,
  gateway,
  nextConfig = { gateway: { ...gateway, ...(auth ? { auth } : {}) } },
  opts = {},
  env = {},
}: {
  auth?: NonNullable<OpenClawConfig["gateway"]>["auth"];
  gateway?: OpenClawConfig["gateway"];
  nextConfig?: OpenClawConfig;
  opts?: OnboardOptions;
  env?: Record<string, string | undefined>;
} = {}) {
  return withEnvAsync(
    {
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      [SAMPLE_SECRET_REF.id]: undefined,
      ...env,
    },
    () => applyNonInteractiveGatewayConfig({ nextConfig, opts, runtime, defaultPort: 18789 }),
  );
}

describe("applyNonInteractiveGatewayConfig auth resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime = createRuntime();
  });

  it.each([
    ["existing-user-token", undefined, { OPENCLAW_GATEWAY_TOKEN: "stale-env-token" }],
    ["existing-user-token", "flag-token", {}],
    [SAMPLE_SECRET_REF, undefined, { OPENCLAW_GATEWAY_TOKEN: "stale-env-token" }],
    [SAMPLE_SECRET_REF, undefined, { [SAMPLE_SECRET_REF.id]: "resolved-secret-value" }],
    [SAMPLE_SECRET_REF, "flag-token", {}],
  ] as const)(
    "preserves token precedence and reference ownership (%#)",
    async (token, gatewayToken, env) => {
      const result = await applyGatewayConfig({
        auth: { mode: "token", token },
        opts: { gatewayToken },
        env,
      });
      expect(result?.nextConfig.gateway?.auth?.token).toEqual(gatewayToken ?? token);
      expect(randomToken).not.toHaveBeenCalled();
    },
  );

  it("selects token auth when --gateway-token overrides a no-auth config", async () => {
    const result = await applyGatewayConfig({
      nextConfig: { gateway: { auth: { mode: "none" } } },
      opts: { gatewayToken: "flag-token" } as OnboardOptions,
    });

    expect(result?.nextConfig.gateway?.auth).toEqual({ mode: "token", token: "flag-token" });
  });

  it("selects password auth when --gateway-password overrides an existing token SecretRef", async () => {
    const result = await applyGatewayConfig({
      auth: { mode: "token", token: SAMPLE_SECRET_REF },
      opts: { gatewayPassword: "explicit-password" } as OnboardOptions,
    });
    expect(result?.nextConfig.gateway?.auth).toMatchObject({
      mode: "password",
      password: "explicit-password",
    });
    expect(randomToken).not.toHaveBeenCalled();
  });

  it("stores an explicit password as a reference to the configured env provider", async () => {
    const result = await applyGatewayConfig({
      nextConfig: {
        secrets: { defaults: { env: "gatewayenv" }, providers: { gatewayenv: { source: "env" } } },
      },
      opts: { gatewayPassword: "gateway-password-from-env", secretInputMode: "ref" },
      env: { OPENCLAW_GATEWAY_PASSWORD: "gateway-password-from-env" },
    });
    expect(result?.nextConfig.gateway?.auth).toMatchObject({
      mode: "password",
      password: { source: "env", provider: "gatewayenv", id: "OPENCLAW_GATEWAY_PASSWORD" },
    });
  });

  it.each([
    {
      name: "an existing plaintext password",
      password: "existing-password",
    },
    {
      name: "an existing password SecretRef",
      password: {
        source: "env" as const,
        provider: "default",
        id: "EXISTING_GATEWAY_PASSWORD",
      },
    },
  ])("preserves $name in reference mode without an explicit replacement", async ({ password }) => {
    const result = await applyGatewayConfig({
      auth: { mode: "password", password },
      opts: { secretInputMode: "ref" },
    });
    expect(result?.nextConfig.gateway?.auth?.password).toEqual(password);
  });

  it.each([
    { name: "an explicit auth mode", opts: { gatewayAuth: "token" as const } },
    { name: "an explicit token credential", opts: { gatewayToken: "flag-token" } },
  ])("keeps $name authoritative over --gateway-password", async ({ opts }) => {
    const result = await applyGatewayConfig({
      opts: { ...opts, gatewayPassword: "explicit-password" } as OnboardOptions,
    });

    expect(result?.nextConfig.gateway?.auth?.mode).toBe("token");
  });

  it("keeps password auth when a token-only rerun targets an existing Funnel", async () => {
    const result = await applyGatewayConfig({
      auth: { mode: "password", password: "test-password" },
      gateway: { tailscale: { mode: "funnel" } },
      opts: { gatewayToken: "flag-token" } as OnboardOptions,
    });
    expect(result?.nextConfig.gateway?.auth).toEqual({
      mode: "password",
      password: "test-password",
    });
  });

  it.each([
    { opts: {}, expectedMode: "trusted-proxy" },
    { opts: { tailscale: "funnel" }, expectedMode: undefined },
    { opts: { tailscale: "funnel", gatewayAuth: "password" }, expectedMode: "password" },
  ] as const)(
    "preserves proxy auth unless explicitly replaced: $opts",
    async ({ opts, expectedMode }) => {
      const auth = {
        mode: "trusted-proxy" as const,
        password: "synthetic-local-password",
        trustedProxy: { userHeader: "x-forwarded-user", allowUsers: ["operator@example.test"] },
      };
      const result = await applyGatewayConfig({
        auth,
        gateway: { trustedProxies: ["10.0.0.5"] },
        opts,
      });
      if (expectedMode === undefined) {
        expect(result).toBeNull();
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("--gateway-auth password"),
        );
        expect(runtime.exit).toHaveBeenCalledWith(1);
      } else {
        expect(result?.nextConfig.gateway?.auth).toEqual({ ...auth, mode: expectedMode });
        expect(result?.nextConfig.gateway?.trustedProxies).toEqual(["10.0.0.5"]);
        expect(runtime.exit).not.toHaveBeenCalled();
      }
      expect(auth.mode).toBe("trusted-proxy");
      expect(randomToken).not.toHaveBeenCalled();
    },
  );

  it("uses OPENCLAW_GATEWAY_TOKEN to fill an empty config on first-run", async () => {
    const result = await applyGatewayConfig({ env: { OPENCLAW_GATEWAY_TOKEN: "env-token" } });

    expect(result?.nextConfig.gateway?.auth?.token).toBe("env-token");
    expect(randomToken).not.toHaveBeenCalled();
  });

  it("generates a random token only when flag, env, and existing config are all empty", async () => {
    const result = await applyGatewayConfig();

    expect(randomToken).toHaveBeenCalledOnce();
    expect(result?.nextConfig.gateway?.auth?.token).toBe("generated-random-token");
  });

  it("establishes token auth when explicitly enabling Tailscale Serve from no-auth", async () => {
    const result = await applyGatewayConfig({
      auth: { mode: "none" },
      gateway: { bind: "loopback", tailscale: { mode: "off" } },
      opts: { tailscale: "serve" } as OnboardOptions,
    });
    expect(result?.nextConfig.gateway?.auth).toEqual({
      mode: "token",
      token: "generated-random-token",
    });
    expect(result?.nextConfig.gateway?.tailscale?.mode).toBe("serve");
  });

  it.each([
    { mode: "token", token: SAMPLE_SECRET_REF },
    { mode: "password", password: "test-password" },
  ] as const)("selects a replacement env token over $mode auth", async (auth) => {
    const newRefId = "OPENCLAW_GATEWAY_TOKEN_NEW_REF";
    const result = await applyGatewayConfig({
      auth,
      opts: { gatewayTokenRefEnv: newRefId },
      env: { [newRefId]: "resolved-new-ref-value" },
    });

    expect(result?.nextConfig.gateway?.auth).toMatchObject({
      mode: "token",
      token: { source: "env", provider: "default", id: newRefId },
    });
    expect(randomToken).not.toHaveBeenCalled();
  });

  it("fails when --gateway-token-ref-env points to a missing env var", async () => {
    const message =
      'Environment variable "MISSING_GATEWAY_TOKEN_ENV" is missing or empty. Export it first, then rerun openclaw onboard --non-interactive.';
    const result = await applyGatewayConfig({
      opts: { gatewayTokenRefEnv: "MISSING_GATEWAY_TOKEN_ENV", json: true } as OnboardOptions,
    });
    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledExactlyOnceWith(message);
    expect(runtime.log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify(
        { ok: false, error: { type: "cli_error", message }, phase: "options", message },
        null,
        2,
      ),
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(randomToken).not.toHaveBeenCalled();
  });

  it("rejects an explicitly empty password instead of preserving the existing password", async () => {
    const result = await applyGatewayConfig({
      auth: { mode: "password", password: "test-password" },
      opts: { gatewayPassword: " " } as OnboardOptions,
    });
    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("--gateway-password"));
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("preserves environment-backed password auth without persisting the password", async () => {
    const result = await applyGatewayConfig({
      auth: { mode: "password" },
      env: { OPENCLAW_GATEWAY_PASSWORD: "environment-password" },
    });
    expect(result?.nextConfig.gateway?.auth).toEqual({ mode: "password" });
  });

  it.each([
    { customBindHost: undefined, message: "--gateway-bind custom requires gateway.customBindHost" },
    { customBindHost: "not-an-ip", message: "Invalid IPv4 address" },
  ])("rejects invalid custom bind host $customBindHost", async ({ customBindHost, message }) => {
    const result = await applyGatewayConfig({
      gateway: { customBindHost },
      opts: { gatewayBind: "custom" },
    });

    expect(result).toBeNull();
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    { gateway: { customBindHost: "192.168.1.100" }, tailscale: undefined, bind: "custom" },
    { gateway: {}, tailscale: "serve", bind: "loopback" },
  ] as const)(
    "normalizes valid custom bind with tailscale=$tailscale",
    async ({ gateway, tailscale, bind }) => {
      const result = await applyGatewayConfig({
        gateway,
        opts: { gatewayBind: "custom", tailscale },
      });
      expect(result?.nextConfig.gateway?.bind).toBe(bind);
      expect(runtime.error).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
    },
  );
});
