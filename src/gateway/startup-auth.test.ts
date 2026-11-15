import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { REDACTED_SENTINEL } from "../config/redact-sentinel.js";
import { getConfigResolutionFacts, setConfigResolutionFacts } from "../config/resolution-facts.js";
import { applyGatewayAuthOverridesForStartupPreflight } from "./server-startup-config-helpers.js";
import { ensureGatewayStartupAuth } from "./startup-auth.js";

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
const authInput = (auth: Auth): StartupInput => ({ cfg: authConfig(auth) });
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
afterEach(() => expect(mocks.replaceConfigFile).not.toHaveBeenCalled());

function refCase(field: "token" | "password", resolved: boolean) {
  const id = `GW_${field.toUpperCase()}`;
  const configured = { field, value: secretRef(id) };
  return {
    name: `${field} SecretRef ${resolved ? "takes precedence over" : "cannot be masked by"} environment`,
    cfg: refConfig({ mode: field, [field]: configured.value }),
    env: {
      [`OPENCLAW_GATEWAY_${field.toUpperCase()}`]: `${field}-from-env`,
      ...(resolved ? { [id]: `${field}-from-config-ref` } : {}),
    },
    configured,
    expectedAuth: { mode: field, [field]: `${field}-from-config-ref` },
    error: new RegExp(id, "i"),
    persist: true,
  };
}

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
    refCase("token", true),
    refCase("password", true),
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
    },
  );

  it.each<[StartupInput, RegExp]>([
    [refCase("token", false), /GW_TOKEN/i],
    [refCase("password", false), /GW_PASSWORD/i],
    [
      {
        ...authInput({ token: "configured-token", password: "configured-password" }),
        persist: true,
      },
      /gateway\.auth\.mode is unset/i,
    ],
    [{ cfg: {}, env: { OPENCLAW_GATEWAY_TOKEN: WEAK_TOKEN } }, /example placeholder/i],
    [authInput({ mode: "token", token: WEAK_TOKEN }), /example placeholder/i],
    [authInput({ mode: "token", token: "undefined" }), /example placeholder/i],
    [
      authInput({ mode: "password", password: "change-me-to-a-strong-password" }),
      /example placeholder/i,
    ],
    [
      authInput({ mode: "password", password: "  undefined  " }),
      /gateway auth password.*Generate a real secret.*OPENCLAW_GATEWAY_PASSWORD.*gateway.auth.password/,
    ],
    [authInput({ mode: "token", token: "" }), /blank/],
  ])("rejects invalid startup credentials %j", async (input, error) => {
    await expect(run(input)).rejects.toThrow(error);
  });

  it("does not generate in explicit none mode", async () => {
    const result = await run({ cfg: authConfig({ mode: "none" }), persist: true });
    expectNoGeneratedToken(result);
    expect(result.auth.mode).toBe("none");
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
