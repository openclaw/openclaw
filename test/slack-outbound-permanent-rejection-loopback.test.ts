// Root-owned integration may combine the public Slack plugin with the durable queue runtime.
import { text as readBodyText } from "node:stream/consumers";
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
import { OUTBOUND_DELIVERY_QUEUE_NAME } from "../src/infra/outbound/delivery-queue-media-staging.js";
import { withServer } from "../src/plugin-sdk/test-helpers/http-test-server.js";

const CLASSIFIED_CODES = ["messages_tab_disabled", "account_inactive"] as const;
const DELIVERY_INTENT_PREFIX = "slack-loopback-permanent-rejection";

type SlackLoopbackRequest = {
  code?: (typeof CLASSIFIED_CODES)[number];
  method: string | undefined;
  text: string;
  url: string;
};

function closeDatabases() {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}

function readQueueTerminal(stateDir: string, intentId: string) {
  const { db } = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  return (
    db
      // sqlite-allow-raw: The proof reads one exact queue owner after terminalization.
      .prepare(
        "SELECT status, retry_count AS retryCount FROM delivery_queue_entries WHERE queue_name = ? AND id = ?",
      )
      .get(OUTBOUND_DELIVERY_QUEUE_NAME, intentId) as
      | { retryCount: number; status: string }
      | undefined
  );
}

describe("Slack permanent rejections over real Web API transport", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    closeDatabases();
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("dead-letters both real platform rejections and never replays them after restart", async () => {
    const requests: SlackLoopbackRequest[] = [];
    await withServer(
      (request, response) => {
        void readBodyText(request).then((body) => {
          const text = new URLSearchParams(body).get("text") ?? "";
          const code = CLASSIFIED_CODES.find((candidate) => text.includes(candidate));
          requests.push({
            ...(code ? { code } : {}),
            method: request.method,
            text,
            url: request.url ?? "",
          });
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: code ?? "unexpected_test_request" }));
        });
      },
      async (baseUrl) => {
        vi.stubEnv("SLACK_API_URL", `${baseUrl}/api/`);
        const { slackPlugin } = await import("../extensions/slack/api.js");
        const cfg: OpenClawConfig = { channels: { slack: { botToken: "xoxb-loopback" } } };
        setActivePluginRegistry(
          createTestRegistry([{ pluginId: "slack", plugin: slackPlugin, source: "test" }]),
        );

        await withStateDirEnv("openclaw-slack-permanent-loopback-", async ({ stateDir }) => {
          try {
            const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
            const queueStatus = (intentId: string) => readQueueTerminal(stateDir, intentId)?.status;
            const drain = (code: string, intentId?: string) =>
              drainPendingDeliveries({
                drainKey: `slack:default:${code}`,
                logLabel: `Slack loopback ${code} recovery`,
                cfg,
                stateDir,
                log,
                selectEntry: (entry) => ({
                  match: intentId ? entry.id === intentId : entry.channel === "slack",
                  bypassBackoff: true,
                }),
              });
            for (const [index, code] of CLASSIFIED_CODES.entries()) {
              const intentId = `${DELIVERY_INTENT_PREFIX}-${code}`;
              const text = `real transport permanent rejection: ${code}`;
              const staged = await sendDurableMessageBatch({
                cfg,
                channel: "slack",
                to: "channel:C123",
                accountId: "default",
                durability: "required",
                deliveryIntentId: intentId,
                completionRetention: {
                  idPrefix: "slack-loopback-",
                  maxAgeMs: 60_000,
                  maxEntries: 10,
                },
                maxRetries: 10,
                payloads: [{ text }],
                deps: {
                  slack: async () => {
                    throw new PlatformMessageNotDispatchedError(
                      "staged before transport for recovery proof",
                      { cause: new Error("loopback transport not released yet") },
                    );
                  },
                },
              });
              expect(staged.status).toBe("failed");
              expect(requests).toHaveLength(index);
              expect(queueStatus(intentId)).toBe("pending");

              log.warn.mockClear();
              await drain(code, intentId);

              expect(requests).toHaveLength(index + 1);
              expect(requests[index]).toMatchObject({
                code,
                method: "POST",
                text,
                url: "/api/chat.postMessage",
              });
              expect(log.warn).toHaveBeenCalledWith(expect.stringContaining(code));
              expect(readQueueTerminal(stateDir, intentId)).toEqual({
                retryCount: 1,
                status: "failed",
              });
            }

            closeDatabases();
            for (const code of CLASSIFIED_CODES) {
              expect(queueStatus(`${DELIVERY_INTENT_PREFIX}-${code}`)).toBe("failed");
            }

            await drain("post-restart");
            expect(requests).toHaveLength(CLASSIFIED_CODES.length);
          } finally {
            closeDatabases();
          }
        });
      },
    );
  });
});
