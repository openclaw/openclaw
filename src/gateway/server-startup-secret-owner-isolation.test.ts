import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveDefaultAgentDir } from "../agents/agent-scope-config.js";
import { getRuntimeAuthProfileStoreSnapshotCore } from "../agents/auth-profiles/runtime-snapshots.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store-runtime.js";
import { resolveMemorySearchConfig } from "../agents/memory-search.js";
import { resolveApiKeyForProviderCore } from "../agents/model-auth.js";
import { resolveSandboxContext } from "../agents/sandbox/context.js";
import type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
import type { ChannelAccountSnapshot, ChannelPlugin } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/config.js";
import { tryReadSecretFileSync } from "../infra/secret-file.js";
import {
  peekSystemEventEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { resolveAuthProfileSecretOwnerId } from "../secrets/runtime-auth-profile-owner.js";
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
const vaultRef = (id: string) => ({ source: "exec" as const, provider: "vault", id });
const memorySearch = (id: string) => ({ search: { remote: { apiKey: envRef(id) } } });
const sandboxIdentity = (id: string) => ({ ssh: { identityData: envRef(id) } });
const openaiProvider = (apiKey: ReturnType<typeof envRef> | ReturnType<typeof vaultRef>) => ({
  providers: { openai: { apiKey, baseUrl: "https://api.openai.com/v1", models: [] } },
});
const elevenlabs = (apiKey: ReturnType<typeof envRef> | ReturnType<typeof vaultRef>) => ({
  providers: { elevenlabs: { apiKey } },
});
const googleSearch = (apiKey: ReturnType<typeof envRef> | ReturnType<typeof vaultRef>) => ({
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

async function startVaultAclFixture() {
  const requests: string[] = [];
  const vault = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("content-type", "application/json");
    response.statusCode = 403;
    response.end(JSON.stringify({ errors: ["permission denied"] }));
  });
  await new Promise<void>((resolve) => {
    vault.listen(0, "127.0.0.1", resolve);
  });
  const address = vault.address();
  assert(address && typeof address !== "string", "Vault ACL fixture did not bind to a TCP port");
  return {
    requests,
    vaultAddr: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        vault.close(() => resolve());
      }),
  };
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
        expect(peekSystemEventEntries("agent:ops:global")).toHaveLength(1);
        expect(peekSystemEventEntries("agent:main:global")).toEqual([]);
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
          const expectStarts = (...ids: string[]) =>
            expect(startAccount.mock.calls.map(([context]) => context.accountId)).toEqual(ids);
          const status = async (expected: Record<string, Partial<ChannelAccountSnapshot>>) => {
            const reply = await rpcReq<{
              channelAccounts: Record<string, ChannelAccountSnapshot[]>;
            }>(ws, "channels.status", { probe: false });
            expect(reply.ok, JSON.stringify(reply)).toBe(true);
            expect(reply.payload?.channelAccounts.telegram).toEqual(
              expect.arrayContaining(
                Object.entries(expected).map(([accountId, fields]) =>
                  expect.objectContaining({ accountId, ...fields }),
                ),
              ),
            );
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
          expect(brokenStart.ok).toBe(false);
          for (const accountId of ["healthy", "stopped"]) {
            const pluginStarted = createDeferred();
            accountStarted.set(accountId, pluginStarted.resolve);
            await accountAction("start", accountId);
            // The RPC acknowledges handoff; traced startup invokes the plugin on a later turn.
            await pluginStarted.promise;
          }
          expectStarts("healthy", "stopped");
          const healthyLifetime = startAccount.mock.calls[0]?.[0].abortSignal;
          const stoppedLifetime = startAccount.mock.calls[1]?.[0].abortSignal;
          expect(healthyLifetime?.aborted).toBe(false);
          expect(stoppedLifetime?.aborted).toBe(false);

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
          expect(brokenStart.error).toMatchObject({ code: "UNAVAILABLE" });
          expectPrivate({ error: brokenStart.error, accounts: before?.channelAccounts.telegram });

          await accountAction("stop", "stopped");
          expect(stoppedLifetime?.aborted).toBe(true);
          expect(healthyLifetime?.aborted).toBe(false);

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
          expectStarts("healthy", "stopped", "broken");
          expect(startAccount.mock.calls[2]?.[0].account.token).toBe(repairedToken);
          expect(healthyLifetime?.aborted).toBe(false);
          expect(stoppedLifetime?.aborted).toBe(true);
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
        expect(active?.degradedOwners).toEqual(
          expect.arrayContaining(
            [
              ["provider", "openai"],
              ["capability", "tts"],
              ["capability", "memory-provider:main"],
              ["capability", "agent-sandbox:cold"],
              ["capability", "cron-webhook"],
              ["capability", "skill:cold"],
              ["capability", "web-search:gemini"],
            ].map(([ownerKind, ownerId]) =>
              expect.objectContaining({ ownerKind, ownerId, state: "unavailable" }),
            ),
          ),
        );
        expectOwnerWarnings(active?.warnings, [
          "models.providers.openai.apiKey",
          "tts.providers.elevenlabs.apiKey",
          "memory.search.remote.apiKey",
          "agents.defaults.sandbox.ssh.identityData",
          "cron.webhookToken",
          "skills.entries.cold.apiKey",
          "plugins.entries.google.config.webSearch.apiKey",
        ]);
        assert(active, "Expected active secrets runtime snapshot");
        expect(() => resolveMemorySearchConfig(active.config, "main")).toThrow(
          expect.objectContaining({
            code: "SECRET_SURFACE_UNAVAILABLE",
            ownerKind: "capability",
            ownerId: "memory-provider:main",
          }),
        );
        await expect(
          resolveSandboxContext({
            config: active.config,
            agentId: "cold",
            sessionKey: "agent:cold:main",
          }),
        ).rejects.toMatchObject({
          code: "sandbox_provisioning",
          backendId: "ssh",
          message: expect.stringContaining("openclaw secrets reload"),
          cause: {
            code: "SECRET_SURFACE_UNAVAILABLE",
            ownerKind: "capability",
            ownerId: "agent-sandbox:cold",
          },
        });
      },
    );
  });

  it.each(["auth outage", "path ACL"])("isolates Vault %s failures", async (failure) => {
    if (process.platform === "win32") {
      return;
    }
    const acl = failure === "path ACL";
    const root = tempDirs.make("openclaw-gateway-vault-");
    const callLogPath = path.join(root, "calls.log");
    const commandPath = path.join(root, "provider.sh");
    const resolverPath = path.resolve("extensions/vault/vault-secret-ref-resolver.js");
    writeFileSync(
      commandPath,
      `#!/bin/sh\n` +
        (acl ? "" : `printf 'call\\n' >> ${JSON.stringify(callLogPath)}\n`) +
        `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(resolverPath)}\n`,
      { encoding: "utf8", mode: 0o700 },
    );
    const vault = acl ? await startVaultAclFixture() : undefined;
    try {
      await withEnvAsync(
        vault
          ? { VAULT_ADDR: vault.vaultAddr, VAULT_TOKEN: "not-a-real-auth-header" }
          : { VAULT_ADDR: "https://vault.example.test" },
        async () => {
          await writeConfig({
            ...baseConfig(),
            secrets: {
              providers: {
                vault: {
                  source: "exec",
                  command: commandPath,
                  passEnv: ["PATH", "VAULT_ADDR", ...(acl ? ["VAULT_TOKEN"] : [])],
                },
              },
            },
            models: openaiProvider(vaultRef("models/openai")),
            tts: elevenlabs(vaultRef("tts/elevenlabs")),
            ...(!acl
              ? {
                  tools: { web: { search: { provider: "gemini" } } },
                  plugins: googleSearch(vaultRef("web/gemini")),
                }
              : {}),
          });

          await expectReady(await start());
          const snapshot = getActiveSecretsRuntimeSnapshot();
          const degradedOwners = snapshot?.degradedOwners ?? [];
          if (!vault) {
            expect(readFileSync(callLogPath, "utf8").trim().split("\n")).toHaveLength(2);
            expect(degradedOwners).toMatchObject(
              [
                ["provider", "openai"],
                ["capability", "tts"],
                ["capability", "web-search:gemini"],
              ].map(([ownerKind, ownerId]) => ({
                ownerKind,
                ownerId,
                providerFailures: [{ source: "exec", provider: "vault" }],
              })),
            );
            return;
          }
          expect(degradedOwners).toMatchObject([
            { ownerKind: "provider", ownerId: "openai", state: "unavailable" },
            { ownerKind: "capability", ownerId: "tts", state: "unavailable" },
          ]);
          expect(degradedOwners.every((owner) => !owner.providerFailures)).toBe(true);
          expectOwnerWarnings(snapshot?.warnings, [
            "models.providers.openai.apiKey",
            "tts.providers.elevenlabs.apiKey",
          ]);
          expect(
            vault.requests.filter((url) => url === "/v1/auth/token/lookup-self").length,
          ).toBeGreaterThan(0);
        },
      );
    } finally {
      await vault?.close();
    }
  });

  it("starts with a selected provider profile cold and fails its first request before dispatch", async () => {
    await withEnvAsync(
      {
        MISSING_SELECTED_PROFILE_KEY: undefined,
        OPENAI_API_KEY: "unused",
      },
      async () => {
        const profileId = "openai:cold";
        const config: OpenClawConfig = {
          ...baseConfig(),
          agents: { defaults: { model: { primary: "openai/gpt-5.4" } } },
          auth: { order: { openai: [profileId] } },
        };
        const agentDir = resolveDefaultAgentDir(config);
        saveAuthProfileStore(
          {
            version: 1,
            profiles: {
              [profileId]: {
                type: "api_key",
                provider: "openai",
                keyRef: envRef("MISSING_SELECTED_PROFILE_KEY"),
              },
            },
          },
          agentDir,
        );
        await writeConfig(config);

        await expectReady(await start());

        const ownerId = resolveAuthProfileSecretOwnerId({ agentDir, profileId });
        const active = getActiveSecretsRuntimeSnapshot();
        expect(active?.degradedOwners).toMatchObject([
          { ownerKind: "account", ownerId, state: "unavailable" },
        ]);
        const store = getRuntimeAuthProfileStoreSnapshotCore(agentDir);
        assert(store && active, "Expected activated Gateway auth profile snapshot");
        const request = vi.fn();
        await expect(
          resolveApiKeyForProviderCore({
            provider: "openai",
            cfg: active.config,
            store,
            agentDir,
          }).then(request),
        ).rejects.toMatchObject({
          code: "SECRET_SURFACE_UNAVAILABLE",
          ownerKind: "account",
          ownerId,
        });
        expect(request).not.toHaveBeenCalled();
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
