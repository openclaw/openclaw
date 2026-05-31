import { describe, expect, it } from "vitest";
import { withEnvOverride, withTempHomeConfig } from "../config/test-helpers.js";
import { shouldUseDirectLoopbackGatewayAuth } from "./direct-loopback-gateway-auth.js";

describe("shouldUseDirectLoopbackGatewayAuth", () => {
  it("recognizes literal configured gateway tokens as shared loopback auth", async () => {
    await withTempHomeConfig(
      {
        gateway: {
          auth: { mode: "token", token: "shared-token" },
        },
      },
      async () => {
        await withEnvOverride({ OPENCLAW_GATEWAY_TOKEN: undefined }, async () => {
          expect(
            await shouldUseDirectLoopbackGatewayAuth({
              url: "ws://127.0.0.1:18789",
              token: "shared-token",
            }),
          ).toBe(true);
        });
      },
    );
  });

  it("keeps unconfigured loopback tokens on the device-token-capable path", async () => {
    await withTempHomeConfig(
      {
        gateway: {
          auth: { mode: "token", token: "shared-token" },
        },
      },
      async () => {
        await withEnvOverride({ OPENCLAW_GATEWAY_TOKEN: undefined }, async () => {
          expect(
            await shouldUseDirectLoopbackGatewayAuth({
              url: "ws://127.0.0.1:18789",
              token: "operator-device-token",
            }),
          ).toBe(false);
        });
      },
    );
  });

  it("recognizes SecretRef-backed configured gateway tokens as shared loopback auth", async () => {
    await withEnvOverride({ CONFIG_GATEWAY_TOKEN: "resolved-shared-token" }, async () => {
      expect(
        await shouldUseDirectLoopbackGatewayAuth({
          url: "ws://127.0.0.1:18789",
          token: "resolved-shared-token",
          config: {
            gateway: {
              auth: {
                mode: "token",
                token: { source: "env", provider: "default", id: "CONFIG_GATEWAY_TOKEN" },
              },
            },
            secrets: {
              providers: {
                default: { source: "env" },
              },
            },
          },
        }),
      ).toBe(true);
    });
  });

  it("does not treat env fallback tokens as shared when a configured token ref differs", async () => {
    await withEnvOverride(
      {
        CONFIG_GATEWAY_TOKEN: "resolved-shared-token",
        OPENCLAW_GATEWAY_TOKEN: "stale-device-token",
      },
      async () => {
        expect(
          await shouldUseDirectLoopbackGatewayAuth({
            url: "ws://127.0.0.1:18789",
            token: "stale-device-token",
            config: {
              gateway: {
                auth: {
                  mode: "token",
                  token: { source: "env", provider: "default", id: "CONFIG_GATEWAY_TOKEN" },
                },
              },
              secrets: {
                providers: {
                  default: { source: "env" },
                },
              },
            },
          }),
        ).toBe(false);
      },
    );
  });

  it("does not treat inactive token auth as shared in password mode", async () => {
    await withEnvOverride(
      {
        OPENCLAW_GATEWAY_TOKEN: "stale-device-token",
        OPENCLAW_GATEWAY_PASSWORD: "shared-password",
      },
      async () => {
        expect(
          await shouldUseDirectLoopbackGatewayAuth({
            url: "ws://127.0.0.1:18789",
            token: "stale-device-token",
            config: {
              gateway: {
                auth: { mode: "password", password: "shared-password" },
              },
            },
          }),
        ).toBe(false);
      },
    );
  });

  it("recognizes literal configured gateway passwords as shared loopback auth", async () => {
    await withTempHomeConfig(
      {
        gateway: {
          auth: { mode: "password", password: "shared-password" },
        },
      },
      async () => {
        await withEnvOverride({ OPENCLAW_GATEWAY_PASSWORD: undefined }, async () => {
          expect(
            await shouldUseDirectLoopbackGatewayAuth({
              url: "ws://127.0.0.1:18789",
              password: "shared-password",
            }),
          ).toBe(true);
        });
      },
    );
  });

  it("keeps unconfigured loopback passwords on the device-token-capable path", async () => {
    await withTempHomeConfig(
      {
        gateway: {
          auth: { mode: "password", password: "shared-password" },
        },
      },
      async () => {
        await withEnvOverride({ OPENCLAW_GATEWAY_PASSWORD: undefined }, async () => {
          expect(
            await shouldUseDirectLoopbackGatewayAuth({
              url: "ws://127.0.0.1:18789",
              password: "operator-password",
            }),
          ).toBe(false);
        });
      },
    );
  });

  it("does not treat explicit loopback passwords as shared when gateway auth is disabled", async () => {
    expect(
      await shouldUseDirectLoopbackGatewayAuth({
        url: "ws://127.0.0.1:18789",
        password: "anything",
        config: {
          gateway: {
            auth: { mode: "none" },
          },
        },
      }),
    ).toBe(false);
  });

  it("recognizes implicit env gateway tokens as shared loopback auth", async () => {
    await withTempHomeConfig(
      {
        gateway: {
          auth: { mode: "token" },
        },
      },
      async () => {
        await withEnvOverride({ OPENCLAW_GATEWAY_TOKEN: "env-shared-token" }, async () => {
          expect(await shouldUseDirectLoopbackGatewayAuth({})).toBe(true);
        });
      },
    );
  });

  it("does not resolve configured token refs for remote explicit-token URLs", async () => {
    await withEnvOverride({ CONFIG_GATEWAY_TOKEN: undefined }, async () => {
      expect(
        await shouldUseDirectLoopbackGatewayAuth({
          url: "wss://remote.example.test/ws",
          token: "explicit-token",
          config: {
            gateway: {
              auth: {
                mode: "token",
                token: { source: "env", provider: "default", id: "CONFIG_GATEWAY_TOKEN" },
              },
            },
            secrets: {
              providers: {
                default: { source: "env" },
              },
            },
          },
        }),
      ).toBe(false);
    });
  });

  it("treats unresolved configured token refs as non-shared loopback tokens", async () => {
    await withEnvOverride({ CONFIG_GATEWAY_TOKEN: undefined }, async () => {
      expect(
        await shouldUseDirectLoopbackGatewayAuth({
          url: "ws://127.0.0.1:18789",
          token: "explicit-token",
          config: {
            gateway: {
              auth: {
                mode: "token",
                token: { source: "env", provider: "default", id: "CONFIG_GATEWAY_TOKEN" },
              },
            },
            secrets: {
              providers: {
                default: { source: "env" },
              },
            },
          },
        }),
      ).toBe(false);
    });
  });

  it("does not resolve configured token refs for remote implicit-auth URLs", async () => {
    await withEnvOverride({ CONFIG_GATEWAY_TOKEN: undefined }, async () => {
      expect(
        await shouldUseDirectLoopbackGatewayAuth({
          url: "wss://remote.example.test/ws",
          config: {
            gateway: {
              auth: {
                mode: "token",
                token: { source: "env", provider: "default", id: "CONFIG_GATEWAY_TOKEN" },
              },
            },
            secrets: {
              providers: {
                default: { source: "env" },
              },
            },
          },
        }),
      ).toBe(false);
    });
  });
});
