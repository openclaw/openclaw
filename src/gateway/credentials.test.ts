import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveConfigForRead } from "../config/io.read-helpers.js";
import { setConfigResolutionFacts } from "../config/resolution-facts.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";
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

function gatewayConfig(gateway: GatewayConfig, secretProvider = false): OpenClawConfig {
  return {
    gateway,
    ...(secretProvider && { secrets: { providers: { default: { source: "env" as const } } } }),
  };
}

function authoredConfig(authored: string, env: NodeJS.ProcessEnv, mode?: "local") {
  const read = resolveConfigForRead(
    { gateway: { ...(mode && { mode }), auth: { mode: "token", token: authored } } },
    env,
  );
  const config = read.resolvedConfigRaw as OpenClawConfig;
  setConfigResolutionFacts(config, read.resolutionFacts);
  return config;
}

const ENV_AUTH = { token: "env-token", password: "env-password" }; // pragma: allowlist secret
const NO_AUTH = { token: undefined, password: undefined };
const TRUSTED_PROXY_PASSWORD = "local-trusted-proxy-password"; // pragma: allowlist secret
const local = (
  auth: GatewayConfig["auth"] = {},
  remote?: GatewayConfig["remote"],
): GatewayConfig => ({ mode: "local", auth, ...(remote && { remote }) });
const remote = (
  credentials: GatewayConfig["remote"] = {},
  auth: GatewayConfig["auth"] = {},
): GatewayConfig => ({
  mode: "remote",
  auth,
  remote: { url: "wss://gateway.example", ...credentials },
});
const withoutEnv = { env: EMPTY_GATEWAY_ENV };
const remoteOnly = {
  remoteTokenFallback: "remote-only",
  remotePasswordFallback: "remote-only",
} as const;
type CredentialCase = [
  string,
  GatewayConfig,
  object | string,
  ResolveFromConfigOverrides?,
  boolean?,
];
const unavailable = (
  name: string,
  gateway: GatewayConfig,
  path: string,
  options: ResolveFromConfigOverrides = {},
): CredentialCase => [name, gateway, path, { ...withoutEnv, ...options }, true];

describe("resolveGatewayCredentialsFromConfig", () => {
  const explicitAuth = { token: "explicit-token", password: "explicit-password" }; // pragma: allowlist secret
  const missingPassword = envSecretRef("MISSING_GATEWAY_PASSWORD");
  const missingLocalToken = { mode: "token", token: envSecretRef("MISSING_LOCAL_TOKEN") } as const;
  const cases: CredentialCase[] = [
    ["prefers explicit auth", { auth: DEFAULT_GATEWAY_AUTH }, explicitAuth, { explicitAuth }],
    ["local env-first", local(DEFAULT_GATEWAY_AUTH), ENV_AUTH, { localPrecedence: "env-first" }],
    [
      "remote precedence overrides",
      remote(DEFAULT_REMOTE_AUTH, DEFAULT_GATEWAY_AUTH),
      { token: "env-token", password: "remote-password" },
      { remoteTokenPrecedence: "env-first", remotePasswordPrecedence: "remote-first" },
    ],
    [
      "remote-only fallback",
      remote({ token: "remote-token" }, DEFAULT_GATEWAY_AUTH),
      { token: "remote-token", password: undefined },
      remoteOnly,
    ],
    [
      "remote mode override",
      local(DEFAULT_GATEWAY_AUTH, DEFAULT_REMOTE_AUTH),
      DEFAULT_REMOTE_AUTH,
      { modeOverride: "remote", remotePasswordPrecedence: "remote-first" },
    ],
    [
      "isolates CLI URL overrides",
      { auth: DEFAULT_GATEWAY_AUTH },
      {},
      { urlOverride: "wss://example.com" },
    ],
    [
      "uses env auth for env URL overrides",
      { auth: DEFAULT_GATEWAY_AUTH },
      ENV_AUTH,
      { urlOverride: "wss://example.com", urlOverrideSource: "env" },
    ],
    ["keeps env ahead of remote fallback", local({}, DEFAULT_REMOTE_AUTH), ENV_AUTH],
    [
      "falls back to remote when local auth is missing",
      local({}, DEFAULT_REMOTE_AUTH),
      DEFAULT_REMOTE_AUTH,
      withoutEnv,
    ],
    [
      "fails closed on env-template local tokens",
      local({ mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" }),
      "gateway.auth.token",
      { env: { OPENCLAW_GATEWAY_TOKEN: "env-token" } },
    ],
    [
      "ignores unresolved password in none mode",
      local({ mode: "none", password: missingPassword }),
      NO_AUTH,
      withoutEnv,
      true,
    ],
    unavailable(
      "requires trusted-proxy password resolution",
      local({ mode: "trusted-proxy", password: missingPassword }),
      "gateway.auth.password",
    ),
    [
      "uses local trusted-proxy password",
      local({ mode: "trusted-proxy", password: TRUSTED_PROXY_PASSWORD }),
      { token: undefined, password: TRUSTED_PROXY_PASSWORD },
      withoutEnv,
    ],
    [
      "does not borrow remote trusted-proxy password",
      local({ mode: "trusted-proxy" }, { password: DEFAULT_REMOTE_AUTH.password }),
      NO_AUTH,
      withoutEnv,
    ],
    [
      "ignores local refs in remote-only mode",
      remote({}, missingLocalToken),
      NO_AUTH,
      { ...withoutEnv, ...remoteOnly },
      true,
    ],
    unavailable(
      "requires local refs when fallback is enabled",
      remote({}, missingLocalToken),
      "gateway.auth.token",
      { remoteTokenFallback: "remote-env-local", remotePasswordFallback: "remote-only" },
    ),
    [
      "uses remote password despite unresolved token",
      remote({
        token: envSecretRef("MISSING_REMOTE_TOKEN"),
        password: DEFAULT_REMOTE_AUTH.password,
      }),
      { token: undefined, password: DEFAULT_REMOTE_AUTH.password },
      withoutEnv,
      true,
    ],
  ];
  for (const credential of ["token", "password"] as const) {
    cases.push(
      unavailable(
        "fails closed on unresolved local " + credential,
        local(
          {
            mode: credential,
            [credential]: envSecretRef("MISSING_LOCAL_" + credential.toUpperCase()),
          },
          { [credential]: "remote-" + credential },
        ),
        "gateway.auth." + credential,
      ),
      unavailable(
        "requires remote " + credential + " resolution",
        remote({ [credential]: envSecretRef("MISSING_REMOTE_" + credential.toUpperCase()) }),
        "gateway.remote." + credential,
        {
          [credential === "token" ? "remoteTokenFallback" : "remotePasswordFallback"]:
            "remote-only",
        },
      ),
    );
  }
  it.each(cases)("%s", (_name, gateway, expected, options, secretProvider) => {
    const resolve = () =>
      resolveGatewayCredentialsFromConfig({
        cfg: gatewayConfig(gateway, secretProvider),
        env: DEFAULT_GATEWAY_ENV,
        ...options,
      });
    if (typeof expected === "string") {
      expect(resolve).toThrow(expected);
    } else {
      expect(resolve()).toStrictEqual(expected);
    }
  });

  it("suppresses both env and local token fallback for strict remote overrides", () => {
    expect(
      resolveGatewayCredentialsFromConfig({
        cfg: gatewayConfig(remote({}, { token: "local-token" })),
        env: { OPENCLAW_GATEWAY_TOKEN: "env-token" },
        remoteTokenFallback: "remote-only",
      }).token,
    ).toBeUndefined();
  });
});

describe("resolveGatewayCredentialsWithSecretInputs", () => {
  it.each([
    ["pending bare shorthand", "$SOURCE", {}, { SOURCE: "${OTHER}" }, true],
    ["substituted template-looking literal", "${SOURCE}", { SOURCE: "${OTHER}" }, {}, false],
  ] satisfies [string, string, NodeJS.ProcessEnv, NodeJS.ProcessEnv, boolean][])(
    "classifies and materializes authored provenance atomically: %s",
    async (_name, authored, readEnv, runtimeEnv, pending) => {
      const config = authoredConfig(authored, readEnv, "local");
      const resolve = () =>
        resolveGatewayCredentialsFromConfig({ cfg: config, env: EMPTY_GATEWAY_ENV });
      const expected = { token: "${OTHER}", password: undefined };
      if (pending) {
        expect(resolve).toThrow("gateway.auth.token");
      } else {
        expect(resolve()).toEqual(expected);
      }
      await expect(
        resolveGatewayCredentialsWithSecretInputs({
          config,
          env: runtimeEnv,
        }),
      ).resolves.toEqual(expected);
    },
  );

  it.each([
    ["token", true],
    ["password", true],
    ["token", false],
    ["password", false],
  ] as const)(
    "resolves config-first %s only when available (%s)",
    async (credential, available) => {
      const id = `${available ? "CONFIG_FIRST" : "MISSING_CONFIG_FIRST"}_${credential.toUpperCase()}`;
      const ref = envSecretRef(id);
      const config = gatewayConfig(
        {
          mode: "local",
          auth: credential === "token" ? { token: ref } : { mode: "password", password: ref },
        },
        true,
      );
      const result = resolveGatewayCredentialsWithSecretInputs({
        config,
        env: {
          [`OPENCLAW_GATEWAY_${credential.toUpperCase()}`]: `env-${credential}`,
          ...(available && { [id]: `config-first-${credential}` }),
        },
      });
      if (available) {
        await expect(result).resolves.toEqual({
          ...NO_AUTH,
          [credential]: `config-first-${credential}`,
        });
      } else {
        await expect(result).rejects.toThrow(`gateway.auth.${credential}`);
      }
    },
  );
});

describe("resolveGatewayCredentialsFromValues", () => {
  it.each([
    ["prefers config", DEFAULT_GATEWAY_AUTH, DEFAULT_GATEWAY_ENV, DEFAULT_GATEWAY_AUTH],
    [
      "rejects unresolved placeholders",
      { token: "${OPENCLAW_GATEWAY_TOKEN}", password: "${OPENCLAW_GATEWAY_PASSWORD}" },
      EMPTY_GATEWAY_ENV,
      NO_AUTH,
    ],
  ])("%s", (_name, config, env, expected) => {
    expect(
      resolveGatewayCredentialsFromValues({
        configToken: config.token,
        configPassword: config.password,
        env,
        tokenPrecedence: "config-first",
        passwordPrecedence: "config-first", // pragma: allowlist secret
      }),
    ).toEqual(expected);
  });
});
