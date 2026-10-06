import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveConfigForRead } from "../config/io.read-helpers.js";
import { setConfigResolutionFacts } from "../config/resolution-facts.js";
import { resolveGatewayCredentialsWithSecretInputs } from "./credentials-secret-inputs.js";

type ResolvedAuth = { token?: string; password?: string };
type GatewayConnectionAuthOptions = Parameters<typeof resolveGatewayCredentialsWithSecretInputs>[0];

type ConnectionAuthCase = {
  name: string;
  cfgLocal: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  options?: Partial<Omit<GatewayConnectionAuthOptions, "config" | "env">>;
  expected: ResolvedAuth;
};

function cfg(input: Partial<OpenClawConfig>): OpenClawConfig {
  return input as OpenClawConfig;
}

function createCredentialConfig(mode: "local" | "remote" = "remote") {
  return {
    gateway: {
      mode,
      auth: {
        token: "local-token",
        password: "local-password", // pragma: allowlist secret
      },
      remote: {
        url: "wss://remote.example",
        token: "remote-token",
        password: "remote-password", // pragma: allowlist secret
      },
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
  const cases: ConnectionAuthCase[] = [
    {
      name: "local mode supports explicit env-first token/password",
      cfgLocal: cfg({
        gateway: {
          mode: "local",
          auth: {
            token: "config-token",
            password: "config-password", // pragma: allowlist secret
          },
        },
      }),
      env: DEFAULT_ENV,
      options: {
        localPrecedence: "env-first",
      },
      expected: {
        token: "env-token",
        password: "env-password", // pragma: allowlist secret
      },
    },
    {
      name: "remote mode defaults to remote-first token and env-first password",
      cfgLocal: createCredentialConfig(),
      env: DEFAULT_ENV,
      expected: {
        token: "remote-token",
        password: "env-password", // pragma: allowlist secret
      },
    },
    {
      name: "remote mode supports env-first token with remote-first password",
      cfgLocal: createCredentialConfig(),
      env: DEFAULT_ENV,
      options: {
        remoteTokenPrecedence: "env-first",
        remotePasswordPrecedence: "remote-first", // pragma: allowlist secret
      },
      expected: {
        token: "env-token",
        password: "remote-password", // pragma: allowlist secret
      },
    },
    {
      name: "remote-only fallback can suppress env/local password fallback",
      cfgLocal: {
        gateway: {
          ...createCredentialConfig().gateway,
          remote: { url: "wss://remote.example", token: "remote-token" },
        },
      },
      env: DEFAULT_ENV,
      options: {
        remoteTokenFallback: "remote-only",
        remotePasswordFallback: "remote-only", // pragma: allowlist secret
      },
      expected: { token: "remote-token", password: undefined },
    },
    {
      name: "modeOverride can force remote precedence while config gateway.mode is local",
      cfgLocal: createCredentialConfig("local"),
      env: DEFAULT_ENV,
      options: {
        modeOverride: "remote",
        remoteTokenPrecedence: "remote-first",
        remotePasswordPrecedence: "remote-first", // pragma: allowlist secret
      },
      expected: {
        token: "remote-token",
        password: "remote-password", // pragma: allowlist secret
      },
    },
  ];

  it.each(cases)("$name", async ({ cfgLocal, env, options, expected }) => {
    const asyncResolved = await resolveGatewayCredentialsWithSecretInputs({
      config: cfgLocal,
      env,
      ...options,
    });
    expect(asyncResolved).toEqual(expected);
  });

  it("resolves an env-template local token through the configured auth path", async () => {
    await expect(
      resolveGatewayCredentialsWithSecretInputs({
        config: cfg({
          gateway: {
            mode: "local",
            auth: { mode: "token", token: "${OPENCLAW_GATEWAY_TOKEN}" },
          },
        }),
        env: { OPENCLAW_GATEWAY_TOKEN: "env-token" },
      }),
    ).resolves.toEqual({ token: "env-token", password: undefined });
  });

  it.each([
    {
      name: "pending bare shorthand",
      authored: "$SOURCE",
      readEnv: {},
      runtimeEnv: { SOURCE: "${OTHER}" },
    },
    {
      name: "substituted template-looking literal",
      authored: "${SOURCE}",
      readEnv: { SOURCE: "${OTHER}" },
      runtimeEnv: {},
    },
  ])(
    "materializes authored provenance atomically: $name",
    async ({ authored, readEnv, runtimeEnv }) => {
      const read = resolveConfigForRead(
        { gateway: { mode: "local", auth: { mode: "token", token: authored } } },
        readEnv,
      );
      const config = cfg(read.resolvedConfigRaw as OpenClawConfig);
      setConfigResolutionFacts(config, read.resolutionFacts);

      await expect(
        resolveGatewayCredentialsWithSecretInputs({ config, env: runtimeEnv }),
      ).resolves.toEqual({ token: "${OTHER}", password: undefined });
    },
  );

  it("preserves escaped literal credentials through async resolution clones", async () => {
    const config = cfg({
      gateway: { mode: "local", auth: { mode: "token", token: "${LITERAL_TOKEN}" } },
    });
    setConfigResolutionFacts(config, new Set());

    await expect(resolveGatewayCredentialsWithSecretInputs({ config, env: {} })).resolves.toEqual({
      token: "${LITERAL_TOKEN}",
      password: undefined,
    });
  });

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
      await expect(
        resolveGatewayCredentialsWithSecretInputs({
          config: createLocalSecretConfig(
            credential,
            `MISSING_CONFIG_FIRST_${credential.toUpperCase()}`,
          ),
          env: { [`OPENCLAW_GATEWAY_${credential.toUpperCase()}`]: `env-${credential}` },
        }),
      ).rejects.toThrow(`gateway.auth.${credential}`);
    },
  );
});
