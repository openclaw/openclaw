import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import type { OnboardOptions } from "../../onboard-types.js";
import { applyNonInteractiveGatewayConfig } from "./gateway-config.js";

const randomToken = vi.hoisted(() => vi.fn(() => "generated-random-token"));
// mock-isolation: Keep generated credentials deterministic while exercising the real normalizer.
vi.mock("../../random-token.js", () => ({ randomToken }));

const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

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
  beforeEach(() => vi.clearAllMocks());

  const ambientToken = { OPENCLAW_GATEWAY_TOKEN: "ambient" };
  it.each([
    ["saved", undefined, ambientToken, "saved"],
    ["saved", "flag-token", {}, "flag-token"],
    [SAMPLE_SECRET_REF, undefined, ambientToken, SAMPLE_SECRET_REF],
    [SAMPLE_SECRET_REF, undefined, { [SAMPLE_SECRET_REF.id]: "resolved" }, SAMPLE_SECRET_REF],
    [SAMPLE_SECRET_REF, "flag-token", {}, "flag-token"],
    [undefined, undefined, { OPENCLAW_GATEWAY_TOKEN: "env-token" }, "env-token"],
    [undefined, undefined, {}, "generated-random-token"],
  ] as const)(
    "preserves token precedence and reference ownership (%#)",
    async (token, gatewayToken, env, expected) => {
      const result = await applyGatewayConfig({
        auth: { mode: "token", token },
        opts: { gatewayToken },
        env,
      });
      expect(result?.nextConfig.gateway?.auth?.token).toEqual(expected);
      expect(randomToken).toHaveBeenCalledTimes(expected === "generated-random-token" ? 1 : 0);
    },
  );

  it("selects token auth when --gateway-token overrides a no-auth config", async () => {
    const result = await applyGatewayConfig({
      auth: { mode: "none" },
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

  it.each(["existing-password", { ...SAMPLE_SECRET_REF, id: "EXISTING_GATEWAY_PASSWORD" }])(
    "preserves existing password %j in reference mode without an explicit replacement",
    async (password) => {
      const result = await applyGatewayConfig({
        auth: { mode: "password", password },
        opts: { secretInputMode: "ref" },
      });
      expect(result?.nextConfig.gateway?.auth?.password).toEqual(password);
    },
  );

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

  it("preserves environment-backed password auth without persisting the password", async () => {
    const result = await applyGatewayConfig({
      auth: { mode: "password" },
      env: { OPENCLAW_GATEWAY_PASSWORD: "environment-password" },
    });
    expect(result?.nextConfig.gateway?.auth).toEqual({ mode: "password" });
  });

  it.each([
    [
      { opts: { gatewayTokenRefEnv: "MISSING_GATEWAY_TOKEN_ENV" } },
      'Environment variable "MISSING_GATEWAY_TOKEN_ENV" is missing or empty.',
    ],
    [
      { auth: { mode: "password", password: "test-password" }, opts: { gatewayPassword: " " } },
      "Missing --gateway-password",
    ],
    [{ opts: { gatewayBind: "custom" } }, "--gateway-bind custom requires gateway.customBindHost"],
    [
      { gateway: { customBindHost: "not-an-ip" }, opts: { gatewayBind: "custom" } },
      "Invalid IPv4 address",
    ],
  ] satisfies Array<[Parameters<typeof applyGatewayConfig>[0], string]>)(
    "rejects invalid gateway options %#",
    async (input, message) => {
      expect(
        await applyGatewayConfig({ ...input, opts: { ...input?.opts, json: true } }),
      ).toBeNull();
      expect(runtime.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(message));
      expect(runtime.exit).toHaveBeenCalledWith(1);
      const logged = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
      const error = String(runtime.error.mock.calls[0]?.[0]);
      expect(runtime.log).toHaveBeenCalledOnce();
      expect(logged).toEqual({
        ok: false,
        error: { type: "cli_error", message: error },
        phase: "options",
        message: error,
      });
      expect(randomToken).not.toHaveBeenCalled();
    },
  );

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
