// Root-owned integration may combine the public Telegram plugin with the durable queue runtime.
import { createServer, type Server } from "node:http";
import { sendDurableMessageBatch } from "openclaw/plugin-sdk/channel-outbound";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  resetGlobalHookRunner,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { drainPendingDeliveries } from "openclaw/plugin-sdk/delivery-queue-runtime";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDeliveryQueueEntryStatus } from "../src/infra/delivery-queue-sqlite.test-support.js";
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../src/infra/outbound/delivery-queue-media-staging.js";
import { listenLoopback, readBody, replyJson } from "./telegram-http.test-support.js";

const MIGRATION_DESCRIPTION = "Bad Request: group chat was upgraded to a supergroup chat";
const DELIVERY_INTENT_ID = "telegram-loopback-permanent-rejection";

const queueStatus = (stateDir: string, id: string) =>
  getDeliveryQueueEntryStatus(OUTBOUND_DELIVERY_QUEUE_NAME, id, stateDir);

function readQueueRow(stateDir: string, id = PROXY_TUNNEL_DELIVERY_INTENT_ID) {
  const { db } = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  const row = db
    // sqlite-allow-raw: The proof reads one exact queue owner after each recovery pass.
    .prepare(
      "SELECT status, retry_count, recovery_state FROM delivery_queue_entries WHERE queue_name = ? AND id = ?",
    )
    .get(OUTBOUND_DELIVERY_QUEUE_NAME, id) as
    | { recovery_state: string | null; retry_count: number; status: string }
    | undefined;
  return row
    ? { recoveryState: row.recovery_state, retryCount: row.retry_count, status: row.status }
    : undefined;
}

function closeDatabases() {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}

afterEach(() => {
  closeDatabases();
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

async function configureTelegram(connection: { apiRoot?: string; proxy?: string }) {
  const { telegramPlugin } = await import("../extensions/telegram/api.js");
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
  );
  return {
    channels: { telegram: { botToken: "123456:loopback", ...connection } },
  } satisfies OpenClawConfig;
}

function stageDelivery(
  cfg: OpenClawConfig,
  deliveryIntentId: string,
  text: string,
  cause: string,
  threadId?: number,
) {
  return sendDurableMessageBatch({
    cfg,
    channel: "telegram",
    to: "123",
    accountId: "default",
    threadId,
    durability: "required",
    deliveryIntentId,
    completionRetention: { idPrefix: "telegram-loopback-", maxAgeMs: 60_000, maxEntries: 10 },
    maxRetries: 10,
    payloads: [{ text }],
    deps: {
      telegram: async () => {
        throw new PlatformMessageNotDispatchedError("staged before transport for recovery proof", {
          cause: new Error(cause),
        });
      },
    },
  });
}

function recoveryDrain(cfg: OpenClawConfig, stateDir: string) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    log,
    drain: (logLabel: string) =>
      drainPendingDeliveries({
        drainKey: "telegram:default",
        logLabel,
        cfg,
        stateDir,
        log,
        selectEntry: (entry) => ({ match: entry.channel === "telegram", bypassBackoff: true }),
      }),
  };
}

async function withTransportState<T extends { close: () => Promise<void> }>(
  transport: T,
  prepare: (transport: T) => Promise<OpenClawConfig>,
  run: (transport: T, stateDir: string, cfg: OpenClawConfig) => Promise<void>,
) {
  try {
    const cfg = await prepare(transport);
    await withStateDirEnv("openclaw-telegram-loopback-", async ({ stateDir }) => {
      try {
        await run(transport, stateDir, cfg);
      } finally {
        closeDatabases();
      }
    });
  } finally {
    await transport.close();
  }
}

async function startTelegramMigrationLoopback() {
  const requests: Array<{ body: string; method: string | undefined; url: string }> = [];
  const server: Server = createServer((request, response) => {
    readBody(request, (body) => {
      requests.push({
        body,
        method: request.method,
        url: request.url ?? "",
      });
      replyJson(
        response,
        {
          ok: false,
          error_code: 400,
          description: MIGRATION_DESCRIPTION,
          parameters: { migrate_to_chat_id: -1_001_234_567_890 },
        },
        400,
      );
    });
  });
  const { url, close } = await listenLoopback(server);
  return { apiRoot: url, requests, close };
}

describe("Telegram permanent rejection over real Bot API transport", () => {
  it("dead-letters one real migration rejection and never replays it after restart", async () => {
    await withTransportState(
      await startTelegramMigrationLoopback(),
      (loopback) => configureTelegram({ apiRoot: loopback.apiRoot }),
      async (loopback, stateDir, cfg) => {
        const staged = await stageDelivery(
          cfg,
          DELIVERY_INTENT_ID,
          "real transport permanent rejection",
          "loopback transport not released yet",
        );
        expect(staged.status).toBe("failed");
        expect(loopback.requests).toHaveLength(0);
        expect(queueStatus(stateDir, DELIVERY_INTENT_ID)).toBe("pending");

        const { log, drain } = recoveryDrain(cfg, stateDir);
        await drain("Telegram loopback permanent rejection recovery");

        expect(loopback.requests).toHaveLength(1);
        expect(log.warn).toHaveBeenCalledWith(
          expect.stringContaining(
            "Telegram rejected send: group migrated to supergroup -1001234567890",
          ),
        );
        expect(loopback.requests[0]).toMatchObject({ method: "POST" });
        expect(loopback.requests[0]?.url).toMatch(/\/sendMessage$/u);
        expect(loopback.requests[0]?.body).toContain("real transport permanent rejection");
        expect(readQueueRow(stateDir, DELIVERY_INTENT_ID)).toMatchObject({
          retryCount: 1,
          status: "failed",
        });

        closeDatabases();
        expect(queueStatus(stateDir, DELIVERY_INTENT_ID)).toBe("failed");

        await drain("Telegram loopback post-restart recovery");
        expect(loopback.requests).toHaveLength(1);
        expect(queueStatus(stateDir, DELIVERY_INTENT_ID)).toBe("failed");
      },
    );
  });
});

describe("Telegram rejected topic delivery over real Bot API transport", () => {
  it.each([
    { description: "message thread not found", acceptedPrefix: false, reset: false },
    { description: "chat not found", acceptedPrefix: false, reset: false },
    { description: "message thread not found", acceptedPrefix: true, reset: false },
    { description: "socket reset", acceptedPrefix: false, reset: true },
  ])(
    "preserves recovery evidence for $description (accepted prefix: $acceptedPrefix)",
    async ({ description, acceptedPrefix, reset }) => {
      const requests: Array<Record<string, unknown>> = [];
      const server = createServer((request, response) => {
        readBody(request, (body) => {
          requests.push(JSON.parse(body));
          if (reset) {
            request.socket.destroy();
            return;
          }
          if (acceptedPrefix && requests.length === 1) {
            replyJson(response, {
              ok: true,
              result: {
                message_id: 101,
                date: 1700000000,
                chat: { id: 123, type: "private" },
                message_thread_id: 42,
                text: requests[0]?.text,
              },
            });
            return;
          }
          replyJson(
            response,
            { ok: false, error_code: 400, description: `Bad Request: ${description}` },
            400,
          );
        });
      });
      await withTransportState(
        await listenLoopback(server),
        (loopback) => configureTelegram({ apiRoot: loopback.url }),
        async (_loopback, stateDir, cfg) => {
          const id = "telegram-loopback-topic-rejection";
          await stageDelivery(cfg, id, "chunked reply ".repeat(500), "awaiting recovery", 42);
          const retryCount = readQueueRow(stateDir, id)?.retryCount ?? 0;
          const ambiguous = acceptedPrefix || reset;
          const terminal = description === "chat not found";
          const expectRecovery = (attempt: number) => {
            const row = readQueueRow(stateDir, id);
            expect(row).toMatchObject({
              status: terminal ? "failed" : "pending",
              retryCount: retryCount + (ambiguous || terminal ? 0 : attempt),
            });
            if (ambiguous) {
              expect(row?.recoveryState).toBe("unknown_after_send");
            } else if (attempt === 1 || !terminal) {
              expect(row?.recoveryState).not.toBe("unknown_after_send");
            }
          };
          const { drain } = recoveryDrain(cfg, stateDir);
          await drain("Telegram rejected topic recovery");
          const firstRequests = acceptedPrefix ? 2 : 1;
          expect(requests).toHaveLength(firstRequests);
          expectRecovery(1);

          // Reopening the DB preserves active producer leases. Ambiguous sends
          // stay protected while a rejected topic can retry its original route.
          closeDatabases();
          await drain("Telegram rejected topic database-reopen recovery");
          expect(requests).toHaveLength(ambiguous || terminal ? firstRequests : 2);
          expectRecovery(2);
          for (const request of requests) {
            expect(request).toMatchObject({ chat_id: "123", message_thread_id: 42 });
          }
        },
      );
    },
  );
});

const PROXY_TUNNEL_DELIVERY_INTENT_ID = "telegram-loopback-proxy-tunnel-refusal";

// A forward proxy whose CONNECT handler always answers 503, the shape a stalled
// upstream (for example an ssh -D hop behind an HTTP proxy) produces. The TLS
// session to api.telegram.org never starts, so nothing can reach Telegram.
async function startRefusingProxy() {
  const connectTargets: string[] = [];
  const server: Server = createServer((_request, response) => {
    response.writeHead(405, { "content-length": "0" });
    response.end();
  });
  server.on("connect", (request, socket) => {
    connectTargets.push(request.url ?? "");
    socket.end(
      "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
  });
  return { ...(await listenLoopback(server)), connectTargets };
}

describe("Telegram proxy tunnel refusal over the real proxy transport", () => {
  it("keeps a durable send replayable while the proxy refuses the CONNECT tunnel", async () => {
    await withTransportState(
      await startRefusingProxy(),
      (proxy) => configureTelegram({ proxy: proxy.url }),
      async (proxy, stateDir, cfg) => {
        const staged = await stageDelivery(
          cfg,
          PROXY_TUNNEL_DELIVERY_INTENT_ID,
          "reply that must survive a proxy tunnel refusal",
          "loopback proxy not released yet",
        );
        expect(staged.status).toBe("failed");
        expect(proxy.connectTargets).toHaveLength(0);
        expect(queueStatus(stateDir, PROXY_TUNNEL_DELIVERY_INTENT_ID)).toBe("pending");
        const stagedRow = readQueueRow(stateDir);
        expect(stagedRow?.status).toBe("pending");
        const stagedRetryCount = stagedRow?.retryCount ?? 0;

        const { log, drain } = recoveryDrain(cfg, stateDir);

        await drain("Telegram loopback proxy tunnel recovery");

        // Every attempt ended at the proxy hop: the in-process retry ran, each
        // attempt targeted the Bot API tunnel, and nothing was accepted.
        const firstPassConnects = proxy.connectTargets.length;
        expect(firstPassConnects).toBeGreaterThanOrEqual(2);
        expect(new Set(proxy.connectTargets)).toEqual(new Set(["api.telegram.org:443"]));
        const afterFirstPass = readQueueRow(stateDir);
        expect(afterFirstPass).toMatchObject({
          retryCount: stagedRetryCount + 1,
          status: "pending",
        });
        // The typed no-send proof keeps the entry replayable instead of parking
        // it as an ambiguous send that recovery must refuse to replay.
        expect(afterFirstPass?.recoveryState).not.toBe("unknown_after_send");
        for (const call of log.warn.mock.calls) {
          expect(String(call[0])).not.toContain("unknown_after_send");
        }

        closeDatabases();
        expect(queueStatus(stateDir, PROXY_TUNNEL_DELIVERY_INTENT_ID)).toBe("pending");

        await drain("Telegram loopback post-restart proxy tunnel recovery");
        expect(proxy.connectTargets.length).toBeGreaterThan(firstPassConnects);
        const afterSecondPass = readQueueRow(stateDir);
        expect(afterSecondPass).toMatchObject({
          retryCount: stagedRetryCount + 2,
          status: "pending",
        });
        expect(afterSecondPass?.recoveryState).not.toBe("unknown_after_send");
      },
    );
  });
});
