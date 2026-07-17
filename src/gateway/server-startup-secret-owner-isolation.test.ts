/** Real Gateway startup coverage for SecretRef owner isolation boundaries. */
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { getActiveSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  getFreePort,
  installGatewayTestHooks,
  startGatewayServer,
  testState,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

async function writeConfig(config: OpenClawConfig): Promise<void> {
  const { writeConfigFile } = await import("../config/config.js");
  await writeConfigFile(config);
}

function baseConfig(): OpenClawConfig {
  return {
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: { mode: "none" },
    },
  };
}

describe("Gateway startup SecretRef owner isolation", () => {
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("reaches /readyz with missing TTS and unused model-provider owners", async () => {
    await withEnvAsync(
      {
        MISSING_TTS_KEY: undefined,
        MISSING_UNUSED_PROVIDER_KEY: undefined,
        OPENAI_API_KEY: "placeholder",
      },
      async () => {
        await writeConfig({
          ...baseConfig(),
          messages: {
            tts: {
              providers: {
                elevenlabs: {
                  apiKey: { source: "env", provider: "default", id: "MISSING_TTS_KEY" },
                },
              },
            },
          },
          models: {
            providers: {
              openai: {
                apiKey: {
                  source: "env",
                  provider: "default",
                  id: "MISSING_UNUSED_PROVIDER_KEY",
                },
                baseUrl: "https://api.openai.com/v1",
                models: [],
              },
            },
          },
        });

        const port = await getFreePort();
        server = await startGatewayServer(port, { auth: { mode: "none" } });
        const ready = await fetch(`http://127.0.0.1:${port}/readyz`);

        expect(ready.status).toBe(200);
        await expect(ready.json()).resolves.toMatchObject({ ready: true });
        expect(getActiveSecretsRuntimeSnapshot()?.degradedOwners).toMatchObject([
          { ownerKind: "provider", ownerId: "openai", state: "unavailable" },
          { ownerKind: "capability", ownerId: "tts", state: "unavailable" },
        ]);
        expect(getActiveSecretsRuntimeSnapshot()?.warnings).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: "SECRETS_OWNER_UNAVAILABLE",
              path: "models.providers.openai.apiKey",
            }),
            expect.objectContaining({
              code: "SECRETS_OWNER_UNAVAILABLE",
              path: "messages.tts.providers.elevenlabs.apiKey",
            }),
          ]),
        );
      },
    );
  });

  it("isolates TTS during a successful Gateway-auth SecretRef preflight", async () => {
    await withEnvAsync(
      {
        GATEWAY_TOKEN_REF: "placeholder",
        MISSING_TTS_KEY: undefined,
      },
      async () => {
        await writeConfig({
          ...baseConfig(),
          gateway: {
            mode: "local",
            bind: "loopback",
            auth: {
              mode: "token",
              token: { source: "env", provider: "default", id: "GATEWAY_TOKEN_REF" },
            },
          },
          messages: {
            tts: {
              providers: {
                elevenlabs: {
                  apiKey: { source: "env", provider: "default", id: "MISSING_TTS_KEY" },
                },
              },
            },
          },
        });
        testState.gatewayAuth = undefined;

        const port = await getFreePort();
        server = await startGatewayServer(port);
        const ready = await fetch(`http://127.0.0.1:${port}/readyz`);

        expect(ready.status).toBe(200);
        expect(getActiveSecretsRuntimeSnapshot()?.config.gateway?.auth?.token).toBe("placeholder");
        expect(getActiveSecretsRuntimeSnapshot()?.degradedOwners).toMatchObject([
          { ownerKind: "capability", ownerId: "tts", state: "unavailable" },
        ]);
      },
    );
  });

  it("still refuses startup when Gateway ingress auth cannot resolve", async () => {
    await withEnvAsync({ MISSING_GATEWAY_TOKEN: undefined }, async () => {
      await writeConfig({
        ...baseConfig(),
        gateway: {
          mode: "local",
          bind: "loopback",
          auth: {
            mode: "token",
            token: { source: "env", provider: "default", id: "MISSING_GATEWAY_TOKEN" },
          },
        },
      });
      testState.gatewayAuth = undefined;

      await expect(startGatewayServer(await getFreePort())).rejects.toThrow(
        /Startup failed: required secrets are unavailable/,
      );
    });
  });

  it("still refuses startup when an unresolved SecretRef owner is unknown", async () => {
    await withEnvAsync({ MISSING_WEBHOOK_TOKEN: undefined }, async () => {
      await writeConfig({
        ...baseConfig(),
        cron: {
          webhookToken: {
            source: "env",
            provider: "default",
            id: "MISSING_WEBHOOK_TOKEN",
          },
        },
      });

      await expect(
        startGatewayServer(await getFreePort(), { auth: { mode: "none" } }),
      ).rejects.toThrow(/Startup failed: required secrets are unavailable/);
    });
  });
});
