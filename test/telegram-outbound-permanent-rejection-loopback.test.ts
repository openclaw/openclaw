// Root-owned integration may combine the public Telegram plugin with the durable queue runtime.
import { createServer } from "node:http";
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

// Refuse CONNECT before TLS starts: nothing can reach Telegram.
async function startRefusingProxy() {
  const connectTargets: string[] = [];
  const server = createServer((_request, response) => {
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
        const expectReplayable = (attempt: number) => {
          const row = readQueueRow(stateDir);
          expect(row).toMatchObject({ retryCount: stagedRetryCount + attempt, status: "pending" });
          expect(row?.recoveryState).not.toBe("unknown_after_send");
        };
        await drain("Telegram loopback proxy tunnel recovery");
        const firstPassConnects = proxy.connectTargets.length;
        expect(firstPassConnects).toBeGreaterThanOrEqual(2);
        expect(new Set(proxy.connectTargets)).toEqual(new Set(["api.telegram.org:443"]));
        expectReplayable(1);
        for (const call of log.warn.mock.calls) {
          expect(String(call[0])).not.toContain("unknown_after_send");
        }

        closeDatabases();
        expect(queueStatus(stateDir, PROXY_TUNNEL_DELIVERY_INTENT_ID)).toBe("pending");

        await drain("Telegram loopback post-restart proxy tunnel recovery");
        expect(proxy.connectTargets.length).toBeGreaterThan(firstPassConnects);
        expectReplayable(2);
      },
    );
  });
});
