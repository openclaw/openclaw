import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveConfigForRead } from "../config/io.read-helpers.js";
import { REDACTED_SENTINEL } from "../config/redact-sentinel.js";
import { setConfigResolutionFacts } from "../config/resolution-facts.js";
import {
  resolveGatewayProbeAuthSafe,
  resolveGatewayProbeAuthSafeWithSecretInputs,
  resolveGatewayProbeTarget,
} from "./probe-auth.js";

const EMPTY_PROBE_AUTH = { token: undefined, password: undefined };
const REMOTE_URL = "wss://gateway.example";
type Gateway = NonNullable<OpenClawConfig["gateway"]>;
const AMBIENT_AUTH = {
  OPENCLAW_GATEWAY_TOKEN: "ambient-token",
  OPENCLAW_GATEWAY_PASSWORD: "ambient-password",
};

function envSecretRef(id: string) {
  return { source: "env", provider: "default", id } as const;
}

function tokenAuthConfig(id: string) {
  return { mode: "token", token: envSecretRef(id) } as const;
}

function configWithDefaultEnvProvider(gateway: Gateway) {
  return {
    gateway,
    secrets: { providers: { default: { source: "env" } } },
  } as OpenClawConfig;
}

function configFromAuthoredToken(token: string, env: NodeJS.ProcessEnv): OpenClawConfig {
  const read = resolveConfigForRead({ gateway: { auth: { mode: "token", token } } }, env);
  const config = read.resolvedConfigRaw as OpenClawConfig;
  setConfigResolutionFacts(config, read.resolutionFacts);
  return config;
}

function resolveSafeProbeAuth(cfg: OpenClawConfig, mode: "local" | "remote" = "local") {
  return resolveGatewayProbeAuthSafe({ cfg, mode, env: {} });
}

function expectUnavailable(result: Awaited<ReturnType<typeof resolveSafeProbeAuth>>, path: string) {
  expect(result.auth).toStrictEqual({});
  expect(result.warning).toContain(path);
}

function resolveAsync(
  cfg: OpenClawConfig,
  options: Partial<
    Omit<Parameters<typeof resolveGatewayProbeAuthSafeWithSecretInputs>[0], "cfg">
  > = {},
) {
  return resolveGatewayProbeAuthSafeWithSecretInputs({ mode: "local", env: {}, ...options, cfg });
}

function resolveLocal(auth: Gateway["auth"], options: Parameters<typeof resolveAsync>[1] = {}) {
  return resolveAsync(configWithDefaultEnvProvider({ auth }), options);
}

function resolveRemote(remote: Gateway["remote"], env: NodeJS.ProcessEnv) {
  const cfg = configWithDefaultEnvProvider({
    mode: "remote",
    remote: { url: REMOTE_URL, ...remote },
  });
  return resolveAsync(cfg, { mode: "remote", env });
}

describe("resolveGatewayProbeAuthSafe", () => {
  it("does not fall through to remote token when local token SecretRef is unresolved", () => {
    const result = resolveSafeProbeAuth(
      configWithDefaultEnvProvider({
        mode: "local",
        auth: tokenAuthConfig("MISSING_GATEWAY_TOKEN"),
        remote: { token: "remote-token" },
      }),
    );
    expectUnavailable(result, "gateway.auth.token");
    expect(result.warning).toContain("unresolved");
  });

  it.each([
    ["local", { auth: { token: "token-value" } }, { token: "token-value", password: undefined }],
    [
      "local",
      { remote: { url: REMOTE_URL, token: "remote-token", password: "remote-password" } },
      EMPTY_PROBE_AUTH,
    ],
    [
      "remote",
      { remote: { url: REMOTE_URL }, auth: tokenAuthConfig("MISSING_LOCAL_TOKEN") },
      EMPTY_PROBE_AUTH,
    ],
  ] as const)("reads only %s surface credentials from %j", (mode, gateway, auth) => {
    expect(resolveSafeProbeAuth(configWithDefaultEnvProvider({ mode, ...gateway }), mode)).toEqual({
      auth,
    });
  });
});

describe("resolveGatewayProbeTarget", () => {
  it.each([undefined, REMOTE_URL])("selects the probe surface for remote URL %s", (url) => {
    expect(resolveGatewayProbeTarget({ gateway: { mode: "remote", remote: { url } } })).toEqual({
      gatewayMode: "remote",
      mode: url ? "remote" : "local",
      remoteUrlMissing: !url,
    });
  });
});

describe("resolveGatewayProbeAuthSafeWithSecretInputs", () => {
  it.each(["config-first", "env-first"] as const)(
    "reports a redacted SecretRef with its identity and remedy under %s precedence",
    async (localPrecedence) => {
      const result = await resolveLocal(tokenAuthConfig("GATEWAY_SECRET"), {
        localPrecedence,
        env: { GATEWAY_SECRET: REDACTED_SENTINEL, OPENCLAW_GATEWAY_TOKEN: "ambient-token" },
      });
      expect(result.auth).toEqual({});
      expect(result.warningCode).toBe("SECRET_REF_REDACTED_VALUE");
      expect(result.warning).toContain("env:default:GATEWAY_SECRET");
      expect(result.warning).toContain("redaction placeholder");
      expect(result.warning).toContain("openclaw doctor --fix");
    },
  );

  it.each([
    { mode: "token" as const, value: "configured-token", expected: "ambient-token" },
    { mode: "password" as const, value: "configured-password", expected: "ambient-password" },
    { mode: "token" as const, value: envSecretRef("PROBE_SECRET"), expected: "resolved-secret" },
    { mode: "password" as const, value: envSecretRef("PROBE_SECRET"), expected: "resolved-secret" },
  ])("keeps env-first $mode precedence unless an explicit SecretRef owns it", async (testCase) => {
    const result = await resolveLocal(
      { mode: testCase.mode, [testCase.mode]: testCase.value },
      {
        localPrecedence: "env-first",
        env: {
          OPENCLAW_GATEWAY_TOKEN: "ambient-token",
          OPENCLAW_GATEWAY_PASSWORD: "ambient-password",
          PROBE_SECRET: "resolved-secret",
        },
      },
    );
    expect(result.warning).toBeUndefined();
    expect(result.auth[testCase.mode]).toBe(testCase.expected);
  });

  it.each(["token", "password"] as const)(
    "does not replace an unavailable active %s SecretRef with env-first auth",
    async (mode) => {
      const result = await resolveLocal(
        { mode, [mode]: envSecretRef("MISSING_PROBE_SECRET") },
        { localPrecedence: "env-first", env: AMBIENT_AUTH },
      );
      expectUnavailable(result, `gateway.auth.${mode}`);
    },
  );

  it("does not bypass an implicit password SecretRef with an env-first ambient token", async () => {
    const result = await resolveLocal(
      { password: envSecretRef("MISSING_IMPLICIT_PASSWORD") },
      {
        localPrecedence: "env-first",
        env: { OPENCLAW_GATEWAY_TOKEN: "ambient-token" },
      },
    );
    expectUnavailable(result, "gateway.auth.password");
  });

  it("preserves a substituted template-looking literal for probe auth", async () => {
    const result = await resolveAsync(configFromAuthoredToken("${SOURCE}", { SOURCE: "${OTHER}" }));
    expect(result).toEqual({ auth: { token: "${OTHER}", password: undefined } });
  });

  it("keeps unresolved authored shorthand unavailable", async () => {
    const result = await resolveAsync(configFromAuthoredToken("${MISSING}", {}));
    expectUnavailable(result, "gateway.auth.token");
    expect(result.warning).toContain("unresolved");
  });

  it("returns warning and empty auth when SecretRef cannot be resolved via async path", async () => {
    const result = await resolveLocal(tokenAuthConfig("MISSING_TOKEN_XYZ"));
    expectUnavailable(result, "gateway.auth.token");
    expect(result.warning).toContain("unresolved");
  });

  it.each([
    [
      "token ref",
      { token: envSecretRef("REMOTE") },
      { token: "remote", password: undefined },
      null,
    ],
    ["password", { password: "remote" }, { token: undefined, password: "remote" }, null],
    ["unavailable token", { token: envSecretRef("MISSING") }, {}, "token"],
    ["unavailable password", { password: envSecretRef("MISSING") }, {}, "password"],
    [
      "unavailable token with configured password",
      { token: envSecretRef("MISSING"), password: "remote" },
      { token: undefined, password: "remote" },
      "token",
    ],
  ] as const)(
    "keeps remote %s authoritative over ambient auth",
    async (_name, remote, auth, warning) => {
      const result = await resolveRemote(remote, { ...AMBIENT_AUTH, REMOTE: "remote" });
      if (warning) {
        expect(result.auth).toStrictEqual(auth);
        expect(result.warning).toContain(`gateway.remote.${warning} SecretRef is unresolved`);
      } else {
        expect(result).toEqual({ auth });
      }
    },
  );

  it("does not resolve a local password SecretRef for a remote probe", async () => {
    const result = await resolveAsync(
      configWithDefaultEnvProvider({
        mode: "remote",
        auth: {
          mode: "password",
          password: envSecretRef("LOCAL_GATEWAY_PASSWORD"),
        },
        remote: { url: REMOTE_URL, token: "remote-token" },
      }),
      {
        mode: "remote",
        env: { LOCAL_GATEWAY_PASSWORD: "local-password" }, // pragma: allowlist secret
      },
    );
    expect(result).toEqual({ auth: { token: "remote-token", password: undefined } });
  });

  it("does not use ambient credentials for a CLI URL override", async () => {
    const result = await resolveAsync(
      {
        gateway: {
          mode: "remote",
          remote: { url: "wss://configured.example" },
        },
      },
      {
        mode: "remote",
        env: {
          OPENCLAW_GATEWAY_PASSWORD: "ambient-password", // pragma: allowlist secret
        },
        urlOverride: "wss://override.example",
        urlOverrideSource: "cli",
      },
    );
    expect(result).toEqual({ auth: {} });
  });
});
