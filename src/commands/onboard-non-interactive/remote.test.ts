import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";
import { withEnvAsync } from "../../test-utils/env.js";
import type { OnboardOptions } from "../onboard-types.js";

const commitNonInteractiveOnboardConfigMock = vi.hoisted(() =>
  vi.fn(async (_params: { nextConfig: OpenClawConfig }) => undefined),
);

vi.mock("./config-write.js", () => ({
  commitNonInteractiveOnboardConfig: commitNonInteractiveOnboardConfigMock,
}));
vi.mock("../../config/logging.js", () => ({ logConfigUpdated: vi.fn() }));

const { runNonInteractiveRemoteSetup } = await import("./remote.js");

describe("runNonInteractiveRemoteSetup", () => {
  const runtime: RuntimeEnv = {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code) => {
      throw new Error(`unexpected exit ${code}`);
    },
  };
  const remoteUrl = "wss://gateway.example.test";
  const tokenRef = { source: "env", provider: "default", id: "OLD_REMOTE_TOKEN" } as const;
  const tlsFingerprint = "sha256:test-fingerprint";
  const edgeAuth = { "X-Edge-Auth": "existing-edge-secret" };
  const remoteConfig = (
    remote: NonNullable<OpenClawConfig["gateway"]>["remote"],
  ): OpenClawConfig => ({
    gateway: { mode: "remote", remote },
  });

  async function setup(opts: Partial<OnboardOptions>, baseConfig: OpenClawConfig) {
    await runNonInteractiveRemoteSetup({
      opts: { nonInteractive: true, mode: "remote", remoteUrl, skipHooks: true, ...opts },
      runtime,
      baseConfig,
    });
    return commitNonInteractiveOnboardConfigMock.mock.calls[0]?.[0].nextConfig.gateway?.remote;
  }

  beforeEach(() => {
    commitNonInteractiveOnboardConfigMock.mockClear();
    vi.mocked(runtime.error).mockClear();
  });

  it.each([
    {
      name: "fresh remote configuration",
      baseConfig: {},
      expectedRemote: { url: remoteUrl, password: "replacement-password" },
    },
    {
      name: "a token SecretRef on the same endpoint",
      baseConfig: remoteConfig({
        url: remoteUrl,
        token: tokenRef,
        tlsFingerprint,
        edgeAuth,
      }),
      expectedRemote: {
        url: remoteUrl,
        password: "replacement-password",
        tlsFingerprint,
        edgeAuth,
      },
    },
    {
      name: "credentials and routing from a different endpoint",
      baseConfig: remoteConfig({
        url: "wss://old-gateway.example.test",
        token: tokenRef,
        password: { source: "env" as const, provider: "default", id: "OLD_REMOTE_PASSWORD" },
        tlsFingerprint: "sha256:old-fingerprint",
        sshTarget: "operator@old-gateway.example.test",
        edgeAuth: { "X-Edge-Auth": "old-edge-secret" },
      }),
      expectedRemote: { url: remoteUrl, password: "replacement-password" },
    },
  ])("stores a remote password while replacing $name", async ({ baseConfig, expectedRemote }) => {
    expect(await setup({ remotePassword: "replacement-password" }, baseConfig)).toEqual(
      expectedRemote,
    );
  });

  it.each([
    ["remoteToken", "token", "OPENCLAW_GATEWAY_TOKEN", "password"],
    ["remotePassword", "password", "OPENCLAW_GATEWAY_PASSWORD", "token"],
  ] as const)(
    "stores %s as a configured-provider env reference and clears the old credential",
    async (option, field, envName, previousField) => {
      await withEnvAsync({ [envName]: "replacement-credential" }, async () => {
        const remote = await setup(
          { [option]: "replacement-credential", secretInputMode: "ref" },
          {
            secrets: {
              defaults: { env: "gatewayenv" },
              providers: { gatewayenv: { source: "env" } },
            },
            ...remoteConfig({
              url: remoteUrl,
              [previousField]: {
                source: "env",
                provider: "default",
                id: "OLD_GATEWAY_CREDENTIAL",
              },
              tlsFingerprint,
            }),
          },
        );

        expect(remote).toEqual({
          url: remoteUrl,
          [field]: { source: "env", provider: "gatewayenv", id: envName },
          tlsFingerprint,
        });
      });
    },
  );

  it("clears a stale password when a token replaces auth for the same endpoint", async () => {
    const remote = await setup(
      { remoteToken: "replacement-token" },
      remoteConfig({
        url: remoteUrl,
        password: "old-password",
        tlsFingerprint,
      }),
    );

    expect(remote).toEqual({
      url: remoteUrl,
      token: "replacement-token",
      tlsFingerprint,
    });
  });

  it.each([
    "existing-password",
    { source: "env" as const, provider: "default", id: "EXISTING_REMOTE_PASSWORD" },
  ])(
    "preserves existing token and password %j when no replacement is provided",
    async (password) => {
      const remote = {
        url: remoteUrl,
        token: "existing-token",
        password,
        tlsFingerprint,
      };

      expect(await setup({ secretInputMode: "ref" }, remoteConfig(remote))).toEqual(remote);
    },
  );
});
