import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveConfigForRead } from "../config/io.read-helpers.js";
import { setConfigResolutionFacts } from "../config/resolution-facts.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";

type ResolvedAuth = { token?: string; password?: string };
type GatewayConnectionAuthOptions = Parameters<typeof resolveGatewayCredentialsWithSecretInputs>[0];
type AuthOptions = Partial<Omit<GatewayConnectionAuthOptions, "config" | "env">>;
const CONFIG_AUTH = { token: "config-token", password: "config-password" }; // pragma: allowlist secret
const LOCAL_AUTH = { token: "local-token", password: "local-password" }; // pragma: allowlist secret
const REMOTE_AUTH = { token: "remote-token", password: "remote-password" }; // pragma: allowlist secret

function createCredentialConfig(
  mode: "local" | "remote" = "remote",
  remote: NonNullable<OpenClawConfig["gateway"]>["remote"] = REMOTE_AUTH,
): OpenClawConfig {
  return {
    gateway: {
      mode,
      auth: LOCAL_AUTH,
      remote: { url: "wss://remote.example", ...remote },
    },
  };
}

function createLocalSecretConfig(credential: "token" | "password", id: string): OpenClawConfig {
  const ref = { source: "env", provider: "default", id } as const;
  return {
    gateway: {
      mode: "local",
      auth: credential === "token" ? { token: ref } : { mode: "password", password: ref },
    },
    secrets: { providers: { default: { source: "env" } } },
  };
}

const DEFAULT_ENV = {
  OPENCLAW_GATEWAY_TOKEN: "env-token",
  OPENCLAW_GATEWAY_PASSWORD: "env-password", // pragma: allowlist secret
} as NodeJS.ProcessEnv;

describe("resolveGatewayCredentialsWithSecretInputs", () => {
  const cases: [string, OpenClawConfig, AuthOptions, ResolvedAuth][] = [
    [
      "local mode supports explicit env-first token/password",
      { gateway: { mode: "local", auth: CONFIG_AUTH } },
      { localPrecedence: "env-first" },
      { token: "env-token", password: "env-password" }, // pragma: allowlist secret
    ],
    [
      "remote mode defaults to remote-first token and env-first password",
      createCredentialConfig(),
      {},
      { token: "remote-token", password: "env-password" }, // pragma: allowlist secret
    ],
    [
      "remote mode supports env-first token with remote-first password",
      createCredentialConfig(),
      {
        remoteTokenPrecedence: "env-first",
        remotePasswordPrecedence: "remote-first", // pragma: allowlist secret
      },
      { token: "env-token", password: "remote-password" }, // pragma: allowlist secret
    ],
    [
      "remote-only fallback can suppress env/local password fallback",
      createCredentialConfig("remote", { token: "remote-token" }),
      {
        remoteTokenFallback: "remote-only",
        remotePasswordFallback: "remote-only", // pragma: allowlist secret
      },
      { token: "remote-token", password: undefined },
    ],
    [
      "modeOverride can force remote precedence while config gateway.mode is local",
      createCredentialConfig("local"),
      {
        modeOverride: "remote",
        remoteTokenPrecedence: "remote-first",
        remotePasswordPrecedence: "remote-first", // pragma: allowlist secret
      },
      { token: "remote-token", password: "remote-password" }, // pragma: allowlist secret
    ],
  ];

  it.each(cases)("%s", async (_name, config, options, expected) => {
    await expect(
      resolveGatewayCredentialsWithSecretInputs({ config, env: DEFAULT_ENV, ...options }),
    ).resolves.toEqual(expected);
  });

  it.each([
    ["pending bare shorthand", "$SOURCE", {}, { SOURCE: "${OTHER}" }],
    ["substituted template-looking literal", "${SOURCE}", { SOURCE: "${OTHER}" }, {}],
  ] satisfies [string, string, NodeJS.ProcessEnv, NodeJS.ProcessEnv][])(
    "materializes authored provenance atomically: %s",
    async (_name, authored, readEnv, runtimeEnv) => {
      const read = resolveConfigForRead(
        { gateway: { mode: "local", auth: { mode: "token", token: authored } } },
        readEnv,
      );
      const config = read.resolvedConfigRaw as OpenClawConfig;
      setConfigResolutionFacts(config, read.resolutionFacts);

      await expect(
        resolveGatewayCredentialsWithSecretInputs({ config, env: runtimeEnv }),
      ).resolves.toEqual({ token: "${OTHER}", password: undefined });
    },
  );

  it.each(["token", "password"] as const)(
    "resolves config-first %s SecretRef even when OPENCLAW env exists",
    async (credential) => {
      const secretId = `CONFIG_FIRST_${credential.toUpperCase()}`;
      const resolved = await resolveGatewayCredentialsWithSecretInputs({
        config: createLocalSecretConfig(credential, secretId),
        env: {
          [`OPENCLAW_GATEWAY_${credential.toUpperCase()}`]: `env-${credential}`,
          [secretId]: `config-first-${credential}`,
        },
      });
      expect(resolved).toEqual({
        token: undefined,
        password: undefined,
        [credential]: `config-first-${credential}`,
      });
    },
  );

  it.each(["token", "password"] as const)(
    "throws when config-first %s SecretRef cannot resolve even if env exists",
    async (credential) => {
      const secretId = `MISSING_CONFIG_FIRST_${credential.toUpperCase()}`;
      await expect(
        resolveGatewayCredentialsWithSecretInputs({
          config: createLocalSecretConfig(credential, secretId),
          env: { [`OPENCLAW_GATEWAY_${credential.toUpperCase()}`]: `env-${credential}` },
        }),
      ).rejects.toThrow(`gateway.auth.${credential}`);
    },
  );
});
