/**
 * Live Discord E2E smoke test (Phase 7 P1).
 *
 * Scenario: a Claude ACP session is spawned via the real gateway against a real
 * Discord guild. After spawn, we assert:
 *   1. The marker appears in the spawned session's transcript (model path OK).
 *   2. The marker appears in the visible Discord thread (delivery path OK).
 *   3. The visible message is authored by the webhook identity ⚙ claude.
 *   4. No forbidden internal chatter leaked into the thread.
 *
 * This test gates on isDiscordE2EEnabled() + the standard live-test flag. It
 * is skipped in default PR CI and will only run when operators set the full
 * OPENCLAW_LIVE_DISCORD_* env bundle (see .env.example).
 *
 * P2/P3/P4 expand this into a full matrix, red-team scenarios, and CI wiring.
 */
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import { isLiveTestEnabled } from "../../agents/live-test-helpers.js";
import { clearRuntimeConfigSnapshot, loadConfig } from "../../config/config.js";
import { GatewayClient } from "../../gateway/client.js";
import { startGatewayServer } from "../../gateway/server.js";
import { sleep } from "../../utils.js";
import { GATEWAY_CLIENT_NAMES } from "../../utils/message-channel.js";
import {
  assertAuthorIdentity,
  assertNoForbiddenChatter,
  assertSessionHistoryContains,
  assertVisibleInThread,
  cleanupBinding,
  isDiscordE2EEnabled,
  resolveDiscordE2EEnv,
  spawnAcpWithMarker,
} from "./discord-e2e-helpers.js";

const LIVE_TIMEOUT_MS = 240_000;
const CONNECT_TIMEOUT_MS = 90_000;

const describeLive = isLiveTestEnabled() && isDiscordE2EEnabled() ? describe : describe.skip;

async function getFreeGatewayPort(): Promise<number> {
  const { getFreePortBlockWithPermissionFallback } = await import("../../test-utils/ports.js");
  return await getFreePortBlockWithPermissionFallback({
    offsets: [0, 1, 2, 4],
    fallbackBase: 41_000,
  });
}

async function waitForGatewayPort(params: {
  host: string;
  port: number;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? CONNECT_TIMEOUT_MS;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: params.host, port: params.port });
      const finish = (ok: boolean) => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(1_000, () => finish(false));
    });
    if (connected) {
      return;
    }
    await sleep(250);
  }
  throw new Error(`timed out waiting for gateway port ${params.host}:${String(params.port)}`);
}

async function connectGatewayClient(params: {
  url: string;
  token: string;
  timeoutMs?: number;
}): Promise<GatewayClient> {
  const timeoutMs = params.timeoutMs ?? CONNECT_TIMEOUT_MS;
  return await new Promise<GatewayClient>((resolve, reject) => {
    let done = false;
    let client: GatewayClient | undefined;
    const finish = (result: { client?: GatewayClient; error?: Error }) => {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(connectTimeout);
      if (result.error) {
        if (client) {
          void client.stopAndWait({ timeoutMs: 1_000 }).catch(() => {});
        }
        reject(result.error);
        return;
      }
      resolve(result.client as GatewayClient);
    };
    client = new GatewayClient({
      url: params.url,
      token: params.token,
      clientName: GATEWAY_CLIENT_NAMES.TEST,
      clientVersion: "dev",
      mode: "test",
      requestTimeoutMs: timeoutMs,
      connectChallengeTimeoutMs: timeoutMs,
      onHelloOk: () => finish({ client }),
      onConnectError: (error) => finish({ error }),
      onClose: (code, reason) =>
        finish({ error: new Error(`gateway closed during connect (${code}): ${reason}`) }),
    });
    const connectTimeout = setTimeout(
      () => finish({ error: new Error("gateway connect timeout") }),
      timeoutMs,
    );
    connectTimeout.unref();
    client.start();
  });
}

describeLive("discord surface e2e (smoke)", () => {
  it(
    "Claude × initial reply: spawn → thread visible → webhook identity → no chatter",
    async () => {
      const previous = {
        configPath: process.env.OPENCLAW_CONFIG_PATH,
        stateDir: process.env.OPENCLAW_STATE_DIR,
        token: process.env.OPENCLAW_GATEWAY_TOKEN,
        port: process.env.OPENCLAW_GATEWAY_PORT,
      };
      const liveEnv = resolveDiscordE2EEnv();
      const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-e2e-"));
      const tempStateDir = path.join(tempRoot, "state");
      const tempConfigPath = path.join(tempRoot, "openclaw.json");
      const port = await getFreeGatewayPort();
      const token = `test-${randomUUID()}`;
      const marker = `DISCORD-E2E-${randomBytes(6).toString("hex").toUpperCase()}`;

      clearRuntimeConfigSnapshot();
      process.env.OPENCLAW_STATE_DIR = tempStateDir;
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
      process.env.OPENCLAW_GATEWAY_PORT = String(port);
      process.env.OPENCLAW_CONFIG_PATH = tempConfigPath;

      // Build a minimal config that enables ACP + discord for this run.
      const baseCfg = loadConfig();
      const nextCfg = {
        ...baseCfg,
        gateway: {
          ...baseCfg.gateway,
          mode: "local",
          bind: "loopback",
          port,
        },
        acp: {
          ...baseCfg.acp,
          enabled: true,
          backend: "acpx",
          defaultAgent: "claude",
          allowedAgents: Array.from(new Set([...(baseCfg.acp?.allowedAgents ?? []), "claude"])),
          dispatch: { ...baseCfg.acp?.dispatch, enabled: true },
        },
        channels: {
          ...baseCfg.channels,
          discord: {
            ...baseCfg.channels?.discord,
            enabled: true,
            accounts: {
              ...baseCfg.channels?.discord?.accounts,
              [liveEnv.accountId]: {
                ...baseCfg.channels?.discord?.accounts?.[liveEnv.accountId],
                enabled: true,
                token: liveEnv.botToken,
              },
            },
          },
        },
      };
      await fs.writeFile(tempConfigPath, `${JSON.stringify(nextCfg, null, 2)}\n`);

      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      await waitForGatewayPort({ host: "127.0.0.1", port });
      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
      });

      let threadId: string | undefined;
      let spawnedSessionKey: string | undefined;
      try {
        const spawn = await spawnAcpWithMarker({
          agentId: "claude",
          marker,
          task: `Reply with exactly this token and nothing else: ${marker}`,
          env: liveEnv,
          gateway: client,
          gatewayEnv: { port, token },
          timeoutMs: LIVE_TIMEOUT_MS - 60_000,
        });
        threadId = spawn.threadId;
        spawnedSessionKey = spawn.spawnedSessionKey;

        // Session transcript must contain the marker. If this fails but the
        // Discord assertion also fails we know the regression is upstream of
        // the delivery surface.
        await assertSessionHistoryContains({
          gateway: client,
          sessionKey: spawnedSessionKey,
          marker,
          timeoutMs: 60_000,
        });

        // Visible Discord thread message must contain the marker.
        const visible = await assertVisibleInThread({
          threadId,
          marker,
          env: liveEnv,
          timeoutMs: 60_000,
        });

        // Identity assertion: webhook-authored, username like ⚙ claude.
        assertAuthorIdentity(visible, {
          webhookId: "present",
          username: /⚙ claude/i,
        });

        // No forbidden chatter leaked into the thread.
        await assertNoForbiddenChatter({
          threadId,
          env: liveEnv,
        });
      } finally {
        if (threadId) {
          await cleanupBinding({
            threadId,
            sessionKey: spawnedSessionKey,
            env: liveEnv,
            gateway: client,
          });
        }
        clearRuntimeConfigSnapshot();
        await client.stopAndWait({ timeoutMs: 2_000 }).catch(() => {});
        await server.close();
        await fs.rm(tempRoot, { recursive: true, force: true });
        for (const [k, v] of Object.entries(previous)) {
          const envKey =
            k === "configPath"
              ? "OPENCLAW_CONFIG_PATH"
              : k === "stateDir"
                ? "OPENCLAW_STATE_DIR"
                : k === "token"
                  ? "OPENCLAW_GATEWAY_TOKEN"
                  : "OPENCLAW_GATEWAY_PORT";
          if (v === undefined) {
            delete process.env[envKey];
          } else {
            process.env[envKey] = v;
          }
        }
      }
    },
    LIVE_TIMEOUT_MS,
  );
});
