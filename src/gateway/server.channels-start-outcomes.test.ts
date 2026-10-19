import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import "../secrets/runtime-telegram.test-support.ts";
import type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import {
  readConfigFileSnapshot,
  resetConfigRuntimeState,
  writeConfigFile,
} from "../config/config.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { SecretRef } from "../config/types.secrets.js";
import { writeJsonAtomic } from "../infra/json-files.js";
import { setActiveDegradedSecretOwners } from "../secrets/runtime-degraded-state.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { withEnvAsync } from "../test-utils/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import {
  connectWebchatClient,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  setTestPluginRegistry,
  startTestGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

type TestAccount = {
  accountId: string;
  enabled?: boolean;
  token?: string;
};

const gatewayConfig = {
  mode: "local",
  bind: "loopback",
  auth: { mode: "none" },
  reload: { mode: "off" },
} as const;
const secret = (id: string): SecretRef => ({ source: "env", provider: "default", id });
const waitForAbort = ({ abortSignal }: ChannelGatewayContext<TestAccount>) =>
  new Promise<void>((resolve) => {
    abortSignal.addEventListener("abort", () => resolve(), { once: true });
  });

function installChannel(
  config: ChannelPlugin<TestAccount>["config"],
  gateway: ChannelPlugin<TestAccount>["gateway"],
) {
  const plugin: ChannelPlugin<TestAccount> = {
    ...createChannelTestPluginBase({ id: "telegram" }),
    config,
    gateway,
  };
  setTestPluginRegistry(createTestRegistry([{ pluginId: "telegram", source: "test", plugin }]));
}

function expectStarted(response: unknown, accountId: string, retryReason?: string) {
  const outcome =
    retryReason === undefined ? { status: "handed-off" } : { status: "retry", reason: retryReason };
  expect(response).toMatchObject({ ok: true, payload: { accountId, started: true, outcome } });
}

async function startActiveAccount(ws: WebSocket, accountId: string) {
  const id = randomUUID();
  const response = onceMessage(ws, (value) => value?.type === "res" && value.id === id);
  const params = { channel: "telegram", accountId };
  ws.send(JSON.stringify({ type: "req", id, method: "channels.start", params }));
  return await response;
}

let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  setActiveDegradedSecretOwners([]);
});

async function startSuppressedGateway() {
  const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
  server = await startTestGatewayServer(portClaim, {
    auth: { mode: "none" },
    channelAutostartSuppression: { reason: "crash-loop-breaker", message: "synthetic safe mode" },
  });
  return portClaim.port;
}

it("starts config-backed accounts manually while breaker suppression remains active", async () => {
  await withEnvAsync(
    {
      BREAKER_RESOLVED_CHANNEL_TOKEN: "resolved-channel-token",
      BREAKER_MISSING_CHANNEL_TOKEN: undefined,
      TELEGRAM_BOT_TOKEN: "ambient-token-must-not-win",
      OPENCLAW_SKIP_CHANNELS: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
    },
    async () => {
      const startAccount = vi.fn(waitForAbort);
      installChannel(
        {
          listAccountIds: (config) => Object.keys(config.channels?.telegram?.accounts ?? {}),
          defaultAccountId: () => "plaintext",
          resolveAccount: (config, accountId) => {
            const id = accountId ?? "plaintext";
            const configured = config.channels?.telegram?.accounts?.[id];
            return {
              accountId: id,
              enabled: configured?.enabled !== false,
              token: typeof configured?.botToken === "string" ? configured.botToken : undefined,
            };
          },
          isEnabled: (account) => account.enabled !== false,
          isConfigured: (account) => Boolean(account.token),
        },
        { startAccount },
      );
      // Authored SecretRefs belong in the source fixture, before runtime config resolution.
      await writeJsonAtomic(
        (await readConfigFileSnapshot()).path,
        {
          gateway: gatewayConfig,
          secrets: { providers: { default: { source: "env" } } },
          channels: {
            telegram: {
              enabled: true,
              healthMonitor: { enabled: false },
              accounts: {
                plaintext: { botToken: "plaintext-channel-token" },
                resolved: { botToken: secret("BREAKER_RESOLVED_CHANNEL_TOKEN") },
                unavailable: { botToken: secret("BREAKER_MISSING_CHANNEL_TOKEN") },
              },
            },
          },
        },
        { durable: false, trailingNewline: true },
      );
      resetConfigRuntimeState();
      const port = await startSuppressedGateway();
      const runtimeConfig = getRuntimeConfigSnapshot();
      expect(runtimeConfig?.channels?.telegram?.accounts).toMatchObject({
        plaintext: { botToken: "plaintext-channel-token" },
        resolved: { botToken: "resolved-channel-token" },
        unavailable: { botToken: secret("BREAKER_MISSING_CHANNEL_TOKEN") },
      });
      expect(startAccount).not.toHaveBeenCalled();

      const ws = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      const start = (accountId: string) => startActiveAccount(ws, accountId);
      try {
        expectStarted(await start("plaintext"), "plaintext");
        await vi.waitFor(() => expect(startAccount).toHaveBeenCalledOnce());
        expect(startAccount.mock.calls[0]?.[0]).toMatchObject({
          accountId: "plaintext",
          account: { token: "plaintext-channel-token" },
        });
        expectStarted(await start("resolved"), "resolved");
        await expect(start("unavailable")).resolves.toMatchObject({
          ok: false,
          error: { code: "UNAVAILABLE" },
        });
        expect(startAccount).toHaveBeenCalledTimes(2);
      } finally {
        ws.close();
      }
    },
  );
});

it("reports skips and in-flight ownership while manual recovery bypasses the breaker", async () => {
  await withEnvAsync(
    { OPENCLAW_SKIP_CHANNELS: undefined, OPENCLAW_SKIP_PROVIDERS: undefined },
    async () => {
      const [stopEntered, releaseStop] = [createDeferred(), createDeferred()] as const;
      const [firstStart, secondStart] = [createDeferred(), createDeferred()] as const;
      const starts = [firstStart, secondStart];
      const startAccount = vi.fn(async (context: ChannelGatewayContext<TestAccount>) => {
        starts.shift()?.resolve();
        await waitForAbort(context);
      });
      const stopAccount = vi.fn(async () => {
        stopEntered.resolve();
        await releaseStop.promise;
      });
      installChannel(
        {
          listAccountIds: () => ["disabled", "healthy", "unconfigured", "cold"],
          defaultAccountId: () => "healthy",
          resolveAccount: (_config, accountId) => ({ accountId: accountId ?? "healthy" }),
          isEnabled: (account) => account.accountId !== "disabled",
          isConfigured: (account) => account.accountId !== "unconfigured",
        },
        { startAccount, stopAccount },
      );
      await writeConfigFile({
        gateway: gatewayConfig,
        channels: { telegram: { enabled: true, healthMonitor: { enabled: false } } },
      });
      const port = await startSuppressedGateway();
      const ws = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      const start = (accountId?: string) =>
        rpcReq(ws, "channels.start", { channel: "telegram", accountId });
      try {
        expect(startAccount).not.toHaveBeenCalled();
        const invalidOverride = await rpcReq(ws, "channels.start", {
          channel: "telegram",
          manual: true,
        });
        expect(invalidOverride).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
        for (const accountId of ["disabled", "unconfigured"]) {
          expect(await start(accountId)).toMatchObject({
            ok: true,
            payload: {
              channel: "telegram",
              accountId,
              started: false,
              outcome: { status: "skipped", reason: accountId },
            },
          });
        }
        setActiveDegradedSecretOwners([
          {
            ownerKind: "account",
            ownerId: "telegram:cold",
            state: "unavailable",
            paths: ["channels.telegram.accounts.cold.botToken"],
            refKeys: ["env:default:SYNTHETIC_MISSING_CHANNEL_TOKEN"],
            reason: "secret reference was not found",
          },
        ]);
        await expect(start("cold")).resolves.toMatchObject({
          ok: false,
          error: { code: "UNAVAILABLE" },
        });
        expect(startAccount).not.toHaveBeenCalled();
        expectStarted(await start(), "healthy");
        await firstStart.promise;
        expectStarted(await start(), "healthy", "task-owned");
        expect(startAccount).toHaveBeenCalledOnce();
        const stopping = rpcReq(ws, "channels.stop", {
          channel: "telegram",
          accountId: "healthy",
        });
        await stopEntered.promise;
        expectStarted(await start("healthy"), "healthy", "stop-in-flight");
        expect(startAccount).toHaveBeenCalledOnce();
        releaseStop.resolve();
        expect(await stopping).toMatchObject({ ok: true, payload: { stopped: true } });
        expectStarted(await start("healthy"), "healthy");
        await secondStart.promise;
        expect(startAccount).toHaveBeenCalledTimes(2);
      } finally {
        releaseStop.resolve();
        ws.close();
      }
    },
  );
});
