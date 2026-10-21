import type { IncomingMessage, ServerResponse } from "node:http";
import { withServer, withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, test } from "vitest";
import { createQaGatewayChild, writeJson } from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  createTelegramApi,
  readTelegramRequest,
  telegramGatewayOptions,
} from "./telegram-gateway.test-support.js";

type JsonObject = Record<string, unknown>;
const BOT_TOKEN = `424242:${"A".repeat(35)}`;
const CHAT_ID = -1001234;
const FAILURE_TEXT = "⚠️ The AI service is having trouble. Please try again in a moment.";
const RAW_ERROR_CANARY = "untrusted-provider-detail-qa-canary";
const RAW_ERROR_DETAIL = `provider returned HTTP 500 ${RAW_ERROR_CANARY}`;
const RAW_RETRY_ERROR_DETAIL = `${RAW_ERROR_DETAIL}; Retry-After: 120 seconds`;
const REQUEST_TEXT =
  "Please investigate this request. This turn should visibly settle even if the agent fails.";

test("visibly settles a message-tool-only Telegram turn after a provider failure", async () => {
  const providerBodies: JsonObject[] = [];
  let providerRequests = 0;
  let sendCount = 0;
  const api = createTelegramApi({
    token: BOT_TOKEN,
    bot: { id: 424242, is_bot: true, first_name: "QA Failure", username: "qa_failure_bot" },
    chat: { id: CHAT_ID, type: "supergroup" },
    messageId: () => 10_000 + ++sendCount,
  });
  api.updates.enqueue({
    update_id: 1,
    message: {
      message_id: 456,
      date: 1_754_000_000,
      chat: { id: CHAT_ID, type: "supergroup", title: "QA" },
      from: { id: 777, is_bot: false, first_name: "QA" },
      text: REQUEST_TEXT,
    },
  });
  const sends = () =>
    api.calls.filter((call) => call.method === "sendMessage").map((call) => call.body);
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (!pathname.startsWith("/v1/")) {
      return await api.handle(req, res);
    }
    providerRequests += 1;
    const raw = await readTelegramRequest(req);
    const body = raw ? (JSON.parse(raw) as JsonObject) : {};
    const isModelRequest = pathname === "/v1/responses";
    if (isModelRequest) {
      providerBodies.push(body);
    }
    // Allow one continuation, then advertise an outage beyond the recovery window.
    const retryHint =
      !isModelRequest || providerBodies.length > 1 ? "; Retry-After: 120 seconds" : "";
    writeJson(res, 500, { error: { message: `${RAW_ERROR_DETAIL}${retryHint}` } });
  };
  await withServer(
    (req, res) => {
      void handleRequest(req, res).catch((error: unknown) => {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    },
    async (apiRoot) =>
      withTempDir("openclaw-telegram-failure-settlement-", async (workspace) => {
        const owner = createQaGatewayChild();
        try {
          const gateway = await owner.start(
            telegramGatewayOptions({
              workspace,
              apiRoot,
              providerBaseUrl: `${apiRoot}/v1`,
              telegram: {
                enabled: true,
                defaultAccount: "proof",
                accounts: {
                  proof: {
                    enabled: true,
                    botToken: BOT_TOKEN,
                    apiRoot,
                    groupPolicy: "open",
                    silentErrorReplies: true,
                    groups: { [String(CHAT_ID)]: { groupPolicy: "open", requireMention: false } },
                    streaming: { mode: "off" },
                  },
                },
              },
              runtimeEnvPatch: {
                OPENCLAW_SKIP_CHANNELS: undefined,
                OPENCLAW_SKIP_PROVIDERS: undefined,
              },
              mutateConfig: (cfg) => {
                cfg.messages = {
                  ...cfg.messages,
                  groupChat: { ...cfg.messages?.groupChat, visibleReplies: "message_tool" },
                };
                cfg.bindings = [
                  ...(cfg.bindings ?? []),
                  { agentId: "qa", match: { channel: "telegram", accountId: "proof" } },
                ];
                return cfg;
              },
            }),
          );
          await expect
            .poll(
              () =>
                sends().map((send) => ({
                  chatId: send.chat_id,
                  silent: send.disable_notification,
                  text: send.text,
                })),
              { interval: 100, timeout: 30_000 },
            )
            .toEqual([{ chatId: String(CHAT_ID), silent: true, text: FAILURE_TEXT }]);
          expect(providerRequests).toBeGreaterThan(0);
          expect(providerBodies[1]?.model).toBe(providerBodies[0]?.model);
          expect(JSON.stringify(providerBodies[1]?.input)).toContain(REQUEST_TEXT);
          expect(providerBodies[1]?.input).not.toEqual(providerBodies[0]?.input);
          expect(gateway.logs()).toContain(RAW_RETRY_ERROR_DETAIL);
          const publicReplies = sends()
            .map((send) => send.text)
            .join("\n");
          expect(publicReplies).not.toContain(RAW_ERROR_DETAIL);
          expect(publicReplies).not.toContain(RAW_ERROR_CANARY);
        } finally {
          await stopQaGatewayFixture(owner);
          for (const poll of api.updates.pendingPolls) {
            poll.destroy();
          }
        }
      }),
  );
}, 120_000);
