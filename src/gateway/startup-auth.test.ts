import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { REDACTED_SENTINEL } from "../config/redact-sentinel.js";
import { getConfigResolutionFacts, setConfigResolutionFacts } from "../config/resolution-facts.js";
import { applyGatewayAuthOverridesForStartupPreflight } from "./server-startup-config-helpers.js";
import { ensureGatewayStartupAuth, mergeGatewayTailscaleConfig } from "./startup-auth.js";

const WEAK_TOKEN = "change-me-to-a-long-random-token";
const mocks = vi.hoisted(() => ({
  replaceConfigFile: vi.fn(async (_params: { nextConfig: OpenClawConfig }) => {}),
}));
vi.mock("../config/mutate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/mutate.js")>()),
  replaceConfigFile: mocks.replaceConfigFile,
}));

type StartupInput = Parameters<typeof ensureGatewayStartupAuth>[0];
type StartupResult = Awaited<ReturnType<typeof ensureGatewayStartupAuth>>;
type Auth = NonNullable<NonNullable<OpenClawConfig["gateway"]>["auth"]>;
const secretRef = (id: string) => ({ source: "env" as const, provider: "default", id });
const authConfig = (auth: Auth): OpenClawConfig => ({ gateway: { auth } });
const refConfig = (auth: Auth): OpenClawConfig => ({
  ...authConfig(auth),
  secrets: { providers: { default: { source: "env" } } },
});
function unresolvedConfig(auth: Auth, field = "token") {
  const cfg = authConfig(auth);
  setConfigResolutionFacts(cfg, new Set([`gateway.auth.${field}`]));
  return cfg;
}
const run = (params: StartupInput) =>
  ensureGatewayStartupAuth({ ...params, env: params.env ?? {} });
function expectNoGeneratedToken(result: StartupResult) {
  expect(result.generatedToken).toBeUndefined();
  expect(result.persistedGeneratedToken).toBe(false);
}
beforeEach(() => {
  vi.restoreAllMocks();
  mocks.replaceConfigFile.mockClear();
});

it("preserves explicit preserveFunnel overrides", () => {
  expect(
    mergeGatewayTailscaleConfig({ mode: "serve", preserveFunnel: false }, { preserveFunnel: true }),
  ).toEqual({ mode: "serve", preserveFunnel: true });
});

describe("ensureGatewayStartupAuth", () => {
  it.each(["config", "environment"])(
    "allows trusted-proxy startup with a redacted optional password from %s",
    async (source) => {
      const warn = vi.fn();
      const result = await run({
        cfg: authConfig({
          mode: "trusted-proxy",
          trustedProxy: { userHeader: "x-forwarded-user" },
          ...(source === "config" ? { password: REDACTED_SENTINEL } : {}),
        }),
        env: source === "environment" ? { OPENCLAW_GATEWAY_PASSWORD: REDACTED_SENTINEL } : {},
        warn,
      });
      expectNoGeneratedToken(result);
      expect(result.auth.mode).toBe("trusted-proxy");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("local password fallback"));
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    },
  );
  it.each(["inline", "ref"])(
    "refuses a redacted %s Gateway token and points to Doctor without generating a replacement",
    async (source) => {
      await expect(
        run({
          cfg: refConfig({
            mode: "token",
            token: source === "inline" ? REDACTED_SENTINEL : secretRef("OPENCLAW_GATEWAY_TOKEN"),
            allowTailscale: true,
          }),
          env: { OPENCLAW_GATEWAY_TOKEN: REDACTED_SENTINEL },
        }),
      ).rejects.toThrow(/redaction (?:sentinel|placeholder).*doctor --fix/);
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    },
  );

  it.each<StartupInput & { name: string; clearsTokenFact?: boolean }>([
    { name: "missing startup auth", cfg: {}, persist: true },
    {
      name: "missing configured token substitution",
      cfg: unresolvedConfig({ mode: "token", token: "${MISSING_GATEWAY_TOKEN}" }),
      clearsTokenFact: true,
    },
    {
      name: "runtime override of explicit non-token mode",
      cfg: authConfig({ mode: "password" }),
      authOverride: { mode: "token" },
      persist: true,
    },
  ])(
    "generates an ephemeral token for $name",
    async ({ cfg, authOverride, persist, clearsTokenFact }) => {
      const result = await run({ cfg, authOverride, persist });
      expect(result.generatedToken).toMatch(/^[0-9a-f]{48}$/);
      expect(result).toMatchObject({
        persistedGeneratedToken: false,
        auth: { mode: "token", token: result.generatedToken },
        cfg: { gateway: { auth: { token: result.generatedToken } } },
      });
      if (clearsTokenFact) {
        expect(getConfigResolutionFacts(result.cfg)?.has("gateway.auth.token")).toBe(false);
      }
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    },
  );

  it.each<
    StartupInput & {
      name: string;
      expectedAuth: Partial<StartupResult["auth"]>;
      configured?: { field: "token" | "password"; value: unknown };
    }
  >([
    {
      name: "byte-identical explicit token override is operator-owned",
      cfg: unresolvedConfig({ mode: "token", token: "${LITERAL_TOKEN}" }),
      authOverride: { token: "${LITERAL_TOKEN}" },
      expectedAuth: { mode: "token", token: "${LITERAL_TOKEN}" },
    },
    {
      name: "environment fallback for unresolved token substitution",
      cfg: unresolvedConfig({ mode: "token", token: "${MISSING_TOKEN}" }),
      env: { OPENCLAW_GATEWAY_TOKEN: "environment-token" },
      expectedAuth: { mode: "token", token: "environment-token" },
    },
    {
      name: "unresolved inactive password in token mode",
      cfg: unresolvedConfig(
        { mode: "token", token: "configured-token", password: "${MISSING_PASSWORD}" },
        "password",
      ),
      expectedAuth: { mode: "token", token: "configured-token" },
    },
    {
      name: "configured token SecretRef takes precedence over environment",
      cfg: refConfig({ mode: "token", token: secretRef("GW_TOKEN") }),
      env: { GW_TOKEN: "token-from-config-ref", OPENCLAW_GATEWAY_TOKEN: "token-from-env" },
      expectedAuth: { mode: "token", token: "token-from-config-ref" },
      configured: { field: "token", value: secretRef("GW_TOKEN") },
    },
    {
      name: "configured password SecretRef takes precedence over environment",
      cfg: refConfig({ mode: "password", password: secretRef("GW_PASSWORD") }),
      env: {
        GW_PASSWORD: "password-from-config-ref",
        OPENCLAW_GATEWAY_PASSWORD: "password-from-env",
      }, // pragma: allowlist secret
      expectedAuth: { mode: "password", password: "password-from-config-ref" }, // pragma: allowlist secret
      configured: { field: "password", value: secretRef("GW_PASSWORD") },
    },
    {
      name: "inactive password SecretRef is not resolved in explicit token mode",
      cfg: refConfig({
        mode: "token",
        token: "configured-token",
        password: { source: "env", provider: "missing", id: "GW_PASSWORD" },
      }),
      expectedAuth: { mode: "token", token: "configured-token" },
    },
  ])(
    "resolves credentials: $name",
    async ({ cfg, env, authOverride, expectedAuth, configured }) => {
      const result = await run({ cfg, env, authOverride, persist: true });
      expectNoGeneratedToken(result);
      expect(result.auth).toMatchObject(expectedAuth);
      if (configured) {
        expect(result.cfg.gateway?.auth?.[configured.field]).toEqual(configured.value);
      }
      expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
    },
  );

  it.each<StartupInput & { name: string; error: RegExp }>([
    {
      name: "environment token masking an unresolved configured ref",
      cfg: refConfig({ mode: "token", token: secretRef("MISSING_GW_TOKEN") }),
      env: { OPENCLAW_GATEWAY_TOKEN: "token-from-env" },
      persist: true,
      error: /MISSING_GW_TOKEN/i,
    },
    {
      name: "ambiguous token/password mode",
      cfg: authConfig({ token: "configured-token", password: "configured-password" }), // pragma: allowlist secret
      persist: true,
      error: /gateway\.auth\.mode is unset/i,
    },
    {
      name: "environment password masking an unresolved configured ref",
      cfg: refConfig({ mode: "password", password: secretRef("MISSING_GW_PASSWORD") }),
      env: { OPENCLAW_GATEWAY_PASSWORD: "password-from-env" },
      persist: true,
      error: /MISSING_GW_PASSWORD/i,
    },
    {
      name: "environment placeholder token",
      cfg: {},
      env: { OPENCLAW_GATEWAY_TOKEN: WEAK_TOKEN },
      error: /example placeholder/i,
    },
    {
      name: "configured placeholder token",
      cfg: authConfig({ mode: "token", token: WEAK_TOKEN }),
      error: /example placeholder/i,
    },
    {
      name: "configured undefined token",
      cfg: authConfig({ mode: "token", token: "undefined" }),
      error: /example placeholder/i,
    },
    {
      name: ".env.example placeholder password",
      cfg: authConfig({ mode: "password", password: "change-me-to-a-strong-password" }), // pragma: allowlist secret
      error: /example placeholder/i,
    },
    {
      name: "invalid password with password-specific recovery advice",
      cfg: authConfig({ mode: "password", password: "  undefined  " }),
      error:
        /gateway auth password.*Generate a real secret.*OPENCLAW_GATEWAY_PASSWORD.*gateway.auth.password/,
    },
    {
      name: "persisted blank token",
      cfg: authConfig({ mode: "token", token: "" }),
      error: /blank/,
    },
  ])("rejects $name", async ({ cfg, env, persist, error }) => {
    await expect(run({ cfg, env, persist })).rejects.toThrow(error);
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });

  it("does not generate in explicit none mode", async () => {
    const result = await run({ cfg: authConfig({ mode: "none" }), persist: true });
    expectNoGeneratedToken(result);
    expect(result.auth.mode).toBe("none");
    expect(mocks.replaceConfigFile).not.toHaveBeenCalled();
  });
  it("preserves an unresolved token fact when an override value is undefined", () => {
    const cfg = unresolvedConfig({ mode: "token", token: "${MISSING_TOKEN}" });
    const next = applyGatewayAuthOverridesForStartupPreflight(cfg, { auth: { token: undefined } });
    expect(getConfigResolutionFacts(next)?.has("gateway.auth.token")).toBe(true);
  });

  it.each([
    { name: "warns for hooks reuse of an environment Gateway token", reuse: true },
    { name: "allows distinct hooks token with Gateway password auth", reuse: false },
  ])("$name", async ({ reuse }) => {
    const warn = vi.fn();
    const shared = "shared-gateway-token-1234567890";
    const result = await run({
      cfg: {
        hooks: { enabled: true, token: reuse ? shared : "distinct-hooks-token-1234567890" },
        ...(!reuse
          ? authConfig({ mode: "password", password: "shared-gateway-password-1234567890" })
          : {}), // pragma: allowlist secret
      },
      env: reuse ? { OPENCLAW_GATEWAY_TOKEN: shared } : {},
      warn,
    });
    expectNoGeneratedToken(result);
    if (reuse) {
      expect(result.auth).toMatchObject({ mode: "token", token: shared });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Security warning"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("openclaw security audit"));
    } else {
      expect(result.auth.mode).toBe("password");
      expect(warn).not.toHaveBeenCalled();
    }
  });
});
