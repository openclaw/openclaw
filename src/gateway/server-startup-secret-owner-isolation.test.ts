import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
import type { ChannelAccountSnapshot, ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import { tryReadSecretFileSync } from "../infra/secret-file.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../infra/system-events.js";
import {
  listActiveDegradedSecretOwners,
  setActiveDegradedSecretOwners,
} from "../secrets/runtime-degraded-state.js";
import { getActiveSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { deleteTestEnvValue, withEnvAsync } from "../test-utils/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import {
  connectWebchatClient,
  installGatewayTestHooks,
  rpcReq,
  setTestPluginRegistry,
  startTestGatewayServer,
  testState,
} from "./test-helpers.js";
import "./server-startup-secret-diagnostics.test-support.js";
import "./server-startup-secret-surfaces.test-support.js";

const { webSearchProviders } = vi.hoisted(() => {
  const credentialPath = "plugins.entries.google.config.webSearch.apiKey";
  return {
    webSearchProviders: [
      {
        pluginId: "google",
        id: "gemini",
        label: "Gemini",
        hint: "Gateway startup owner-isolation provider",
        envVars: ["GEMINI_API_KEY"],
        placeholder: "gemini-...",
        signupUrl: "https://example.com/gemini",
        autoDetectOrder: 20,
        credentialPath,
        inactiveSecretPaths: [credentialPath],
        getCredentialValue: (config: { apiKey?: unknown } | undefined) => config?.apiKey,
        setCredentialValue: (config: { apiKey?: unknown }, value: unknown) => {
          config.apiKey = value;
        },
        getConfiguredCredentialValue: (config: OpenClawConfig | undefined) => {
          const pluginConfig = config?.plugins?.entries?.google?.config;
          return pluginConfig && typeof pluginConfig === "object"
            ? (pluginConfig as { webSearch?: { apiKey?: unknown } }).webSearch?.apiKey
            : undefined;
        },
        setConfiguredCredentialValue: () => {},
        createTool: () => null,
      },
    ],
  };
});

vi.mock("../plugins/plugin-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/plugin-registry.js")>()),
  resolveManifestContractPluginIds: ({ contract }: { contract: string }) =>
    contract === "webSearchProviders" ? ["google"] : [],
  resolveManifestContractOwnerPluginId: ({ value }: { value: string }) =>
    value === "gemini" ? "google" : undefined,
}));

vi.mock("../plugins/web-provider-public-artifacts.explicit.js", () => ({
  resolveBundledExplicitWebSearchProvidersFromPublicArtifacts: () => webSearchProviders,
  resolveBundledExplicitWebFetchProvidersFromPublicArtifacts: () => [],
}));

vi.mock("../plugins/web-provider-public-artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/web-provider-public-artifacts.js")>()),
  resolveBundledWebSearchProvidersFromPublicArtifacts: () => webSearchProviders,
  resolveBundledWebFetchProvidersFromPublicArtifacts: () => [],
}));

vi.mock("../secrets/runtime-web-tools-fallback.runtime.js", () => ({
  runtimeWebToolsFallbackProviders: {
    resolvePluginWebSearchProviders: () => webSearchProviders,
    resolvePluginWebFetchProviders: () => [],
  },
}));

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function writeConfig(config: OpenClawConfig): Promise<void> {
  const { writeConfigFile } = await import("../config/config.js");
  await writeConfigFile(config);
}

function baseConfig(): OpenClawConfig {
  return { gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } } };
}

const envRef = (id: string) => ({ source: "env" as const, provider: "default", id });
const memorySearch = (id: string) => ({ search: { remote: { apiKey: envRef(id) } } });
const sandboxIdentity = (id: string) => ({ ssh: { identityData: envRef(id) } });
const openaiProvider = (apiKey: ReturnType<typeof envRef>) => ({
  providers: { openai: { apiKey, baseUrl: "https://api.openai.com/v1", models: [] } },
});
const elevenlabs = (apiKey: ReturnType<typeof envRef>) => ({
  providers: { elevenlabs: { apiKey } },
});
const googleSearch = (apiKey: ReturnType<typeof envRef>) => ({
  enabled: true,
  entries: { google: { enabled: true, config: { webSearch: { apiKey } } } },
});

function expectOwnerWarnings(warnings: unknown, paths: string[]) {
  expect(warnings).toEqual(
    expect.arrayContaining(
      paths.map((configPath) =>
        expect.objectContaining({ code: "SECRETS_OWNER_UNAVAILABLE", path: configPath }),
      ),
    ),
  );
}

describe("Gateway startup SecretRef owner isolation", () => {
  let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;

  async function start(auth = true) {
    const claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    server = await startTestGatewayServer(claim, auth ? { auth: { mode: "none" } } : undefined);
    return claim.port;
  }

  async function expectReady(port: number) {
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({ ready: true });
  }

  async function withAdminClient(
    run: (ws: Awaited<ReturnType<typeof connectWebchatClient>>) => Promise<void>,
  ) {
    const ws = await connectWebchatClient({ port: await start(), scopes: ["operator.admin"] });
    try {
      await run(ws);
    } finally {
      ws.close();
    }
  }

  afterEach(async () => {
    await server?.close();
    server = undefined;
    setActiveDegradedSecretOwners([]);
    resetSystemEventsForTest();
  });

  it("routes secrets reload state events to the configured system agent", async () => {
    await withEnvAsync({ SYSTEM_OWNER_SECRET: "available" }, async () => {
      await writeConfig({
        ...baseConfig(),
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "ops" } },
          entries: { main: {}, ops: {} },
        },
        session: { scope: "global" },
        secrets: { providers: { default: { source: "env" } } },
        tts: elevenlabs(envRef("SYSTEM_OWNER_SECRET")),
      });

      await withAdminClient(async (ws) => {
        deleteTestEnvValue("SYSTEM_OWNER_SECRET");
        const reload = await rpcReq<{ warningCount?: number }>(ws, "secrets.reload", {});

        expect(reload.ok, JSON.stringify(reload)).toBe(true);
        expect(reload.payload?.warningCount).toBeGreaterThan(0);
        expect(peekSystemEvents("agent:ops:global")).toEqual([
          expect.stringContaining("[SECRETS_RELOADER_DEGRADED]"),
        ]);
        expect(peekSystemEvents("agent:main:global")).toEqual([]);
      });
    });
  });

  it("recovers only a repaired credential-file account through secrets.reload without restarting sibling accounts", async () => {
    await withEnvAsync(
      { OPENCLAW_SKIP_CHANNELS: undefined, OPENCLAW_SKIP_PROVIDERS: undefined },
      async () => {
        const credentialPath = path.join(tempDirs.make("openclaw-gateway-credential-"), "token");
        const credentialConfigPath = "channels.telegram.accounts.broken.tokenFile";
        const repairedToken = "repaired-test-token-never-public";
        type TestAccount = {
          accountId: string;
          token?: string;
          credentialDiagnostics?: Array<{
            code: "CREDENTIAL_FILE_UNAVAILABLE";
            path: string;
            reason: string;
          }>;
        };
        const accountStarted = new Map<string, () => void>();
        const startAccount = vi.fn(
          async ({ accountId, abortSignal }: ChannelGatewayContext<TestAccount>) =>
            await new Promise<void>((resolve) => {
              abortSignal.addEventListener("abort", () => resolve(), { once: true });
              accountStarted.get(accountId)?.();
            }),
        );
        const plugin: ChannelPlugin<TestAccount> = {
          ...createChannelTestPluginBase({ id: "telegram" }),
          config: {
            listAccountIds: (config) => Object.keys(config.channels?.telegram?.accounts ?? {}),
            resolveAccount: (config, accountId) => {
              assert(accountId, "Missing Telegram test account id");
              const configured = config.channels?.telegram?.accounts?.[accountId];
              assert(configured, `Missing Telegram test account ${accountId}`);
              const credential = configured.tokenFile
                ? tryReadSecretFileSync(
                    configured.tokenFile,
                    "Telegram bot token",
                    {},
                    { configPath: credentialConfigPath },
                  )
                : { status: "available" as const, value: configured.botToken };
              return {
                accountId,
                ...(credential.status === "configured_unavailable"
                  ? { credentialDiagnostics: [credential.diagnostic] }
                  : { token: typeof credential.value === "string" ? credential.value : undefined }),
              };
            },
          },
          gateway: { startAccount },
        };
        setTestPluginRegistry(
          createTestRegistry([{ pluginId: "telegram", source: "test", plugin }]),
        );
        await writeConfig({
          ...baseConfig(),
          gateway: { ...baseConfig().gateway, reload: { mode: "off" } },
          channels: {
            telegram: {
              enabled: true,
              healthMonitor: { enabled: false },
              accounts: {
                broken: { tokenFile: credentialPath },
                healthy: { botToken: "healthy-test-token" },
                stopped: { botToken: "stopped-test-token" },
              },
            },
          },
        });
        const configPath = process.env.OPENCLAW_CONFIG_PATH;
        assert(configPath, "Gateway test did not configure a config file path");
        const originalConfig = readFileSync(configPath);
        await withAdminClient(async (ws) => {
          const accountAction = async (action: "start" | "stop", accountId: string) => {
            const reply = await rpcReq(ws, `channels.${action}`, {
              channel: "telegram",
              accountId,
            });
            expect(reply, JSON.stringify(reply)).toMatchObject({
              ok: true,
              payload: { accountId, [action === "start" ? "started" : "stopped"]: true },
            });
          };
          const status = async (expected: Record<string, Partial<ChannelAccountSnapshot>>) => {
            const reply = await rpcReq<{
              channelAccounts: Record<string, ChannelAccountSnapshot[]>;
            }>(ws, "channels.status", { probe: false });
            expect(reply.ok, JSON.stringify(reply)).toBe(true);
            expect(
              Object.fromEntries(
                (reply.payload?.channelAccounts.telegram ?? []).map(({ accountId, ...account }) => [
                  accountId,
                  account,
                ]),
              ),
            ).toMatchObject(expected);
            return reply.payload;
          };
          const expectPrivate = (value: unknown) => {
            for (const secret of [credentialPath, repairedToken]) {
              expect(JSON.stringify(value)).not.toContain(secret);
            }
          };
          const brokenStart = await rpcReq(ws, "channels.start", {
            channel: "telegram",
            accountId: "broken",
          });
          expect(brokenStart).toMatchObject({ ok: false, error: { code: "UNAVAILABLE" } });
          for (const accountId of ["healthy", "stopped"]) {
            const pluginStarted = createDeferred();
            accountStarted.set(accountId, pluginStarted.resolve);
            await accountAction("start", accountId);
            // The RPC acknowledges handoff; traced startup invokes the plugin on a later turn.
            await pluginStarted.promise;
          }
          const healthyLifetime = startAccount.mock.calls[0]?.[0].abortSignal;
          const stoppedLifetime = startAccount.mock.calls[1]?.[0].abortSignal;
          const expectLifetimes = (healthy: boolean, stopped: boolean) =>
            expect([healthyLifetime?.aborted, stoppedLifetime?.aborted]).toEqual([
              healthy,
              stopped,
            ]);
          expectLifetimes(false, false);

          const before = await status({
            broken: { configured: true, running: false },
            healthy: { running: true },
            stopped: { running: true },
          });
          expect(listActiveDegradedSecretOwners()).toContainEqual(
            expect.objectContaining({
              ownerId: "telegram:broken",
              paths: [credentialConfigPath],
              reason: "credential file is unavailable",
            }),
          );
          expectPrivate({ error: brokenStart.error, accounts: before?.channelAccounts.telegram });

          await accountAction("stop", "stopped");
          expectLifetimes(false, true);

          writeFileSync(credentialPath, repairedToken, { mode: 0o600 });
          expect(readFileSync(configPath)).toEqual(originalConfig);

          const repairedStarted = createDeferred();
          accountStarted.set("broken", repairedStarted.resolve);
          const reload = await rpcReq<{ warningCount: number }>(ws, "secrets.reload", {});
          expect(reload, JSON.stringify(reload)).toMatchObject({
            ok: true,
            payload: { warningCount: 0 },
          });
          await repairedStarted.promise;
          expect(
            startAccount.mock.calls.map(([{ accountId, account }]) => [accountId, account.token]),
          ).toEqual([
            ["healthy", "healthy-test-token"],
            ["stopped", "stopped-test-token"],
            ["broken", repairedToken],
          ]);
          expectLifetimes(false, true);
          expect(listActiveDegradedSecretOwners()).not.toContainEqual(
            expect.objectContaining({ ownerId: "telegram:broken" }),
          );

          expectPrivate(
            await status({
              broken: { running: true },
              healthy: { running: true },
              stopped: { running: false },
            }),
          );
          expect(readFileSync(configPath)).toEqual(originalConfig);
        });
      },
    );
  });

  it("reaches /readyz while isolating every optional owner family", async () => {
    await withEnvAsync(
      {
        GATEWAY_TOKEN_REF: "placeholder",
        GEMINI_API_KEY: "test-gemini-api-key",
        HEALTHY_MEMORY_KEY: "healthy-memory-key",
        HEALTHY_SANDBOX_IDENTITY: "healthy-sandbox-identity",
        OPENCLAW_TEST_ACTIVE_WEB_SEARCH_SECRET: undefined,
        MISSING_MEMORY_KEY: undefined,
        MISSING_SANDBOX_IDENTITY: undefined,
        MISSING_SKILL_KEY: undefined,
        MISSING_TTS_KEY: undefined,
        MISSING_UNUSED_PROVIDER_KEY: undefined,
        MISSING_WEBHOOK_TOKEN: undefined,
      },
      async () => {
        await writeConfig({
          ...baseConfig(),
          gateway: {
            ...baseConfig().gateway,
            auth: { mode: "token", token: envRef("GATEWAY_TOKEN_REF") },
          },
          secrets: { providers: { default: { source: "env" } } },
          tts: elevenlabs(envRef("MISSING_TTS_KEY")),
          models: openaiProvider(envRef("MISSING_UNUSED_PROVIDER_KEY")),
          tools: {
            media: {
              models: [{ provider: "openai", capabilities: ["audio"] }],
              audio: { enabled: true },
            },
            web: { search: { enabled: true, provider: "gemini" } },
          },
          memory: memorySearch("MISSING_MEMORY_KEY"),
          agents: {
            ownership: "explicit",
            defaults: {
              systemAgent: { agentId: "main" },
              sandbox: {
                mode: "all",
                backend: "ssh",
                ssh: {
                  target: "sandbox@example.com:22",
                  identityData: envRef("MISSING_SANDBOX_IDENTITY"),
                },
              },
            },
            entries: {
              main: { sandbox: sandboxIdentity("HEALTHY_SANDBOX_IDENTITY") },
              cold: { memory: memorySearch("HEALTHY_MEMORY_KEY") },
            },
          },
          cron: { webhookToken: envRef("MISSING_WEBHOOK_TOKEN") },
          skills: { entries: { cold: { apiKey: envRef("MISSING_SKILL_KEY") } } },
          plugins: googleSearch(envRef("OPENCLAW_TEST_ACTIVE_WEB_SEARCH_SECRET")),
        });
        testState.gatewayAuth = undefined;

        await expectReady(await start(false));
        const active = getActiveSecretsRuntimeSnapshot();
        expect(active?.config.gateway?.auth?.token).toBe("placeholder");
        expectOwnerWarnings(active?.warnings, [
          "models.providers.openai.apiKey",
          "tts.providers.elevenlabs.apiKey",
          "memory.search.remote.apiKey",
          "agents.defaults.sandbox.ssh.identityData",
          "cron.webhookToken",
          "skills.entries.cold.apiKey",
          "plugins.entries.google.config.webSearch.apiKey",
        ]);
      },
    );
  });

  it("still refuses startup when Gateway ingress auth cannot resolve", async () => {
    await withEnvAsync({ MISSING_GATEWAY_TOKEN: undefined }, async () => {
      await writeConfig({
        ...baseConfig(),
        gateway: {
          ...baseConfig().gateway,
          auth: { mode: "token", token: envRef("MISSING_GATEWAY_TOKEN") },
        },
      });
      testState.gatewayAuth = undefined;

      await expect(start(false)).rejects.toThrow(
        /Startup failed: required secrets are unavailable/,
      );
    });
  });
});
