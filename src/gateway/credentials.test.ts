import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveConfigForRead } from "../config/io.read-helpers.js";
import { setConfigResolutionFacts } from "../config/resolution-facts.js";
import {
  resolveGatewayCredentialsFromConfig,
  resolveGatewayCredentialsFromValues,
} from "./credentials.js";

type ResolveFromConfigInput = Parameters<typeof resolveGatewayCredentialsFromConfig>[0];
type GatewayConfig = NonNullable<OpenClawConfig["gateway"]>;
type ResolveFromConfigOverrides = Partial<Omit<ResolveFromConfigInput, "cfg">>;

const DEFAULT_GATEWAY_AUTH = { token: "config-token", password: "config-password" }; // pragma: allowlist secret
const DEFAULT_REMOTE_AUTH = { token: "remote-token", password: "remote-password" }; // pragma: allowlist secret
const DEFAULT_GATEWAY_ENV = {
  OPENCLAW_GATEWAY_TOKEN: "env-token",
  OPENCLAW_GATEWAY_PASSWORD: "env-password", // pragma: allowlist secret
} as NodeJS.ProcessEnv;
const EMPTY_GATEWAY_ENV = {} as NodeJS.ProcessEnv;

function envSecretRef(id: string) {
  return { source: "env", provider: "default", id } as const;
}

function resolveGatewayCredentialsFor(
  gateway: GatewayConfig,
  overrides: ResolveFromConfigOverrides = {},
  secretProvider = false,
) {
  return resolveGatewayCredentialsFromConfig({
    cfg: {
      gateway,
      ...(secretProvider && { secrets: { providers: { default: { source: "env" as const } } } }),
    },
    env: DEFAULT_GATEWAY_ENV,
    ...overrides,
  });
}

function resolveLocalGatewayCredentials(gateway: GatewayConfig) {
  return resolveGatewayCredentialsFor({ mode: "local", ...gateway }, { env: EMPTY_GATEWAY_ENV });
}

function resolveRemoteGatewayCredentials(
  remote: GatewayConfig["remote"] = {},
  overrides: ResolveFromConfigOverrides = {},
  auth: GatewayConfig["auth"] = {},
  secretProvider = true,
) {
  return resolveGatewayCredentialsFor(
    { mode: "remote", remote: { url: "wss://gateway.example", ...remote }, auth },
    { env: EMPTY_GATEWAY_ENV, ...overrides },
    secretProvider,
  );
}

const ENV_AUTH = { token: "env-token", password: "env-password" }; // pragma: allowlist secret
const NO_AUTH = { token: undefined, password: undefined };
const TRUSTED_PROXY_PASSWORD = "local-trusted-proxy-password"; // pragma: allowlist secret

function resolveLocalModeWithUnresolvedPassword(mode: "none" | "trusted-proxy") {
  return resolveGatewayCredentialsFor(
    {
      mode: "local",
      auth: { mode, password: envSecretRef("MISSING_GATEWAY_PASSWORD") },
    },
    { env: EMPTY_GATEWAY_ENV },
    true,
  );
}

describe("resolveGatewayCredentialsFromConfig", () => {
  it("prefers explicit credentials over config and environment", () => {
    const resolved = resolveGatewayCredentialsFor(
      { auth: DEFAULT_GATEWAY_AUTH },
      {
        explicitAuth: { token: "explicit-token", password: "explicit-password" }, // pragma: allowlist secret
      },
    );
    expect(resolved).toEqual({
      token: "explicit-token",
      password: "explicit-password", // pragma: allowlist secret
    });
  });

  it("returns empty credentials when url override is used without explicit auth", () => {
    const resolved = resolveGatewayCredentialsFor(
      { auth: DEFAULT_GATEWAY_AUTH },
      { urlOverride: "wss://example.com" },
    );
    expect(resolved).toStrictEqual({});
  });

  it("uses env credentials for env-sourced url overrides", () => {
    const resolved = resolveGatewayCredentialsFor(
      { auth: DEFAULT_GATEWAY_AUTH },
      {
        urlOverride: "wss://example.com",
        urlOverrideSource: "env",
      },
    );
    expect(resolved).toEqual(ENV_AUTH);
  });

  it("keeps env ahead of remote fallback when local auth is missing", () => {
    const resolved = resolveGatewayCredentialsFor({
      mode: "local",
      auth: {},
      remote: DEFAULT_REMOTE_AUTH,
    });
    expect(resolved).toEqual(ENV_AUTH);
  });

  it("falls back to remote credentials in local mode when local auth is missing", () => {
    const resolved = resolveLocalGatewayCredentials({
      remote: DEFAULT_REMOTE_AUTH,
      auth: {},
    });
    expect(resolved).toEqual(DEFAULT_REMOTE_AUTH);
  });

  it.each(["token", "password"] as const)(
    "fails closed when local %s SecretRef is unresolved and remote fallback exists",
    (credential) => {
      expect(() =>
        resolveGatewayCredentialsFor(
          {
            mode: "local",
            auth: {
              mode: credential,
              [credential]: envSecretRef(`MISSING_LOCAL_${credential.toUpperCase()}`),
            },
            remote: { [credential]: `remote-${credential}` },
          },
          { env: EMPTY_GATEWAY_ENV },
          true,
        ),
      ).toThrow(`gateway.auth.${credential}`);
    },
  );

  it("fails closed on env-template local tokens in the synchronous resolver", () => {
    expect(() =>
      resolveGatewayCredentialsFor(
        {
          mode: "local",
          auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
        },
        { env: { OPENCLAW_GATEWAY_TOKEN: "env-token" } },
      ),
    ).toThrow("gateway.auth.token");
  });

  it("ignores unresolved local password ref when local auth mode is none", () => {
    const resolved = resolveLocalModeWithUnresolvedPassword("none");
    expect(resolved).toEqual(NO_AUTH);
  });

  it("throws when trusted-proxy local password SecretRef cannot resolve", () => {
    expect(() => resolveLocalModeWithUnresolvedPassword("trusted-proxy")).toThrow(
      "gateway.auth.password",
    );
  });

  it("resolves trusted-proxy local password credentials", () => {
    const resolved = resolveLocalGatewayCredentials({
      auth: { mode: "trusted-proxy", password: TRUSTED_PROXY_PASSWORD },
    });
    expect(resolved).toEqual({ token: undefined, password: TRUSTED_PROXY_PASSWORD });
  });

  it("does not use remote password as trusted-proxy local fallback", () => {
    const resolved = resolveLocalGatewayCredentials({
      auth: { mode: "trusted-proxy" },
      remote: { password: "remote-password" }, // pragma: allowlist secret
    });

    expect(resolved).toEqual(NO_AUTH);
  });

  it("supports remote-only token fallback for strict remote override call sites", () => {
    const resolved = resolveRemoteGatewayCredentials(
      {},
      {
        env: { OPENCLAW_GATEWAY_TOKEN: "env-token" },
        remoteTokenFallback: "remote-only",
      },
      { token: "local-token" },
      false,
    );
    expect(resolved.token).toBeUndefined();
  });

  it.each(["token", "password"] as const)(
    "throws when remote %s auth relies on an unresolved SecretRef",
    (credential) => {
      expect(() =>
        resolveRemoteGatewayCredentials(
          { [credential]: envSecretRef(`MISSING_REMOTE_${credential.toUpperCase()}`) },
          credential === "token"
            ? { remoteTokenFallback: "remote-only" }
            : { remotePasswordFallback: "remote-only" }, // pragma: allowlist secret
        ),
      ).toThrow(`gateway.remote.${credential}`);
    },
  );

  const missingLocalToken = { mode: "token", token: envSecretRef("MISSING_LOCAL_TOKEN") } as const;

  it("ignores unresolved local token ref in remote-only mode when local auth mode is token", () => {
    const resolved = resolveRemoteGatewayCredentials(
      {},
      {
        remoteTokenFallback: "remote-only",
        remotePasswordFallback: "remote-only", // pragma: allowlist secret
      },
      missingLocalToken,
    );
    expect(resolved).toEqual(NO_AUTH);
  });

  it("throws for unresolved local token ref in remote mode when local fallback is enabled", () => {
    expect(() =>
      resolveRemoteGatewayCredentials(
        {},
        {
          remoteTokenFallback: "remote-env-local",
          remotePasswordFallback: "remote-only", // pragma: allowlist secret
        },
        missingLocalToken,
      ),
    ).toThrow("gateway.auth.token");
  });

  it("uses remote password when remote token ref is unresolved", () => {
    const resolved = resolveRemoteGatewayCredentials({
      token: envSecretRef("MISSING_REMOTE_TOKEN"),
      password: "remote-password", // pragma: allowlist secret
    });
    expect(resolved).toEqual({
      token: undefined,
      password: "remote-password", // pragma: allowlist secret
    });
  });

  it.each([
    { name: "unresolved bare shorthand", authored: "$MISSING", env: {}, expected: null },
    {
      name: "substituted braced-looking literal",
      authored: "${SOURCE}",
      env: { SOURCE: "${OTHER}" },
      expected: "${OTHER}",
    },
  ])(
    "classifies gateway credentials from authored provenance: $name",
    ({ authored, env, expected }) => {
      const read = resolveConfigForRead(
        { gateway: { auth: { mode: "token", token: authored } } },
        env,
      );
      const config = read.resolvedConfigRaw as OpenClawConfig;
      setConfigResolutionFacts(config, read.resolutionFacts);
      const resolve = () =>
        resolveGatewayCredentialsFromConfig({ cfg: config, env: EMPTY_GATEWAY_ENV });

      if (expected === null) {
        expect(resolve).toThrow("gateway.auth.token");
        return;
      }
      expect(resolve()).toEqual({
        token: expected,
        password: undefined,
      });
    },
  );
});

describe("resolveGatewayCredentialsFromValues", () => {
  it("supports config-first precedence for token/password", () => {
    const resolved = resolveGatewayCredentialsFromValues({
      configToken: "config-token",
      configPassword: "config-password", // pragma: allowlist secret
      env: DEFAULT_GATEWAY_ENV,
      tokenPrecedence: "config-first",
      passwordPrecedence: "config-first", // pragma: allowlist secret
    });
    expect(resolved).toEqual({
      token: "config-token",
      password: "config-password", // pragma: allowlist secret
    });
  });

  it("rejects unresolved env var placeholders in config credentials", () => {
    const resolved = resolveGatewayCredentialsFromValues({
      configToken: "${OPENCLAW_GATEWAY_TOKEN}",
      configPassword: "${OPENCLAW_GATEWAY_PASSWORD}",
      env: {} as NodeJS.ProcessEnv,
      tokenPrecedence: "config-first",
      passwordPrecedence: "config-first", // pragma: allowlist secret
    });
    expect(resolved).toEqual({ token: undefined, password: undefined });
  });
});
