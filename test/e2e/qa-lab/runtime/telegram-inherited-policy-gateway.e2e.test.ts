import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { withServer, withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, test } from "vitest";
import {
  type MockOpenAiRequestSnapshot,
  createQaGatewayChild,
  startQaMockOpenAiServer,
  writeJson,
  type QaGatewayChild,
} from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { createTelegramApi, telegramGatewayOptions } from "./telegram-gateway.test-support.js";

const BOT_ID = 424242;
const BOT_TOKEN = `${BOT_ID}:${"A".repeat(35)}`;
const CHAT_ID = -1002468135790;
const ALLOWED_SENDER = 1357;
const FORBIDDEN_SENDER = 2468;
const REJECTED_MARKER = "QA-INHERITED-POLICY-FORBIDDEN";
const REPLY_MARKER = "QA-INHERITED-POLICY-ADMITTED";
const REJECTION = `Blocked telegram group message from ${FORBIDDEN_SENDER} (groupPolicy: allowlist)`;
const repoRoot = path.resolve(import.meta.dirname, "../../../..");

test.each(["allowlist", "open"] as const)(
  "enforces inherited root %s before Telegram dispatch and delivers admitted messages",
  async (groupPolicy) => {
    const bot = { id: BOT_ID, is_bot: true, first_name: "QA Policy", username: "qa_policy_bot" };
    const chat = { id: CHAT_ID, type: "supergroup", title: "QA Policy Room", is_forum: false };
    const api = createTelegramApi({
      token: BOT_TOKEN,
      bot,
      chat,
      messageId: (count) => 9000 + count,
      now: () => Math.floor(Date.now() / 1000),
    });
    const { calls: telegramCalls, updates } = api;
    let updateId = 0;
    const sendInbound = (senderId: number, marker: string) => {
      const update = {
        update_id: ++updateId,
        message: {
          message_id: updateId,
          date: Math.floor(Date.now() / 1000),
          chat,
          from: { id: senderId, is_bot: false, first_name: "QA Sender" },
          text: `Reply exactly: ${marker}`,
        },
      };
      updates.enqueue(update);
    };

    await withServer(
      (req, res) => {
        void api.handle(req, res).catch((error: unknown) => {
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
        });
      },
      async (apiRoot) =>
        await withTempDir("openclaw-telegram-policy-", async (workspace) => {
          const mock = await startQaMockOpenAiServer();
          const gatewayOwner = createQaGatewayChild();
          let gateway: QaGatewayChild | undefined;
          const evidence: Record<string, unknown> = {
            head: execFileSync("git", ["rev-parse", "HEAD"], {
              cwd: repoRoot,
              encoding: "utf8",
            }).trim(),
            groupPolicy,
            accountId: "proof",
            accountPolicy: "omitted",
            passed: false,
            groupAllowFrom: [String(ALLOWED_SENDER)],
          };
          const modelRequests = async () => {
            const response = await fetch(`${mock.baseUrl}/debug/requests`);
            expect(response.ok).toBe(true);
            return (await response.json()) as MockOpenAiRequestSnapshot[];
          };
          const inflightRequests = async () => {
            const response = await fetch(`${mock.baseUrl}/debug/inflight-requests`);
            expect(response.ok).toBe(true);
            return (await response.json()) as unknown[];
          };
          const telegramSessions = async () => {
            const result = (await gateway?.call("sessions.list", {})) as {
              sessions: Array<{ key: string; channel?: string; lastRunId?: string }>;
            };
            return result.sessions.filter(
              (session) => session.channel === "telegram" || session.key.includes(":telegram:"),
            );
          };
          const deliveries = () => telegramCalls.filter((call) => call.method === "sendMessage");
          try {
            gateway = await gatewayOwner.start(
              telegramGatewayOptions({
                workspace,
                apiRoot,
                command: {
                  executablePath: process.execPath,
                  argsPrefix: [path.join(repoRoot, "dist", "index.js")],
                  argsSuffix: ["--verbose"],
                },
                providerMode: "mock-openai",
                providerBaseUrl: `${mock.baseUrl}/v1`,
                telegram: {
                  enabled: true,
                  defaultAccount: "proof",
                  groupPolicy,
                  groupAllowFrom: [String(ALLOWED_SENDER)],
                  groups: { "*": { requireMention: false } },
                  accounts: {
                    proof: {
                      enabled: true,
                      botToken: BOT_TOKEN,
                      apiRoot,
                      commands: { native: false },
                      streaming: { mode: "off" },
                    },
                  },
                },
                messages: { groupChat: { visibleReplies: "automatic" } },
                mutateConfig: (cfg) => {
                  cfg.logging = { level: "debug", file: path.join(workspace, "gateway.log") };
                  cfg.bindings = [
                    { agentId: "qa", match: { channel: "telegram", accountId: "proof" } },
                  ];
                  return cfg;
                },
              }),
            );
            evidence.gatewayPort = new URL(gateway.baseUrl).port;
            expect(evidence.gatewayPort).not.toBe("18789");
            await expect
              .poll(() => updates.pendingPolls.size, { timeout: 30_000 })
              .toBeGreaterThan(0);
            // Synchronize on the actual denial before checking that no downstream work happened.
            if (groupPolicy === "allowlist") {
              sendInbound(FORBIDDEN_SENDER, REJECTED_MARKER);
              await expect.poll(() => gateway?.logs(), { timeout: 30_000 }).toContain(REJECTION);
              expect(await modelRequests()).toEqual([]);
              expect(await inflightRequests()).toEqual([]);
              expect(await telegramSessions()).toEqual([]);
              expect(deliveries()).toEqual([]);
              evidence.rejected = {
                decision: REJECTION,
                modelRequests: 0,
                inflightRequests: 0,
                telegramSessions: 0,
                outboundReplies: 0,
              };
            }
            const senderId = groupPolicy === "allowlist" ? ALLOWED_SENDER : FORBIDDEN_SENDER;
            sendInbound(senderId, REPLY_MARKER);
            await expect
              .poll(
                async () => ({
                  rejection: groupPolicy === "open" && gateway?.logs().includes(REJECTION),
                  delivered: deliveries().some((call) => call.body.text === REPLY_MARKER),
                }),
                { timeout: 30_000 },
              )
              .toEqual({ rejection: false, delivered: true });
            const requests = await modelRequests();
            expect(
              requests.some(
                (request) =>
                  request.requestKind === "agent-initial" &&
                  request.allInputText.includes(REPLY_MARKER),
              ),
            ).toBe(true);
            expect(requests.some((request) => request.allInputText.includes(REJECTED_MARKER))).toBe(
              false,
            );
            expect(deliveries()).toHaveLength(1);
            expect(String(deliveries()[0]?.body.chat_id)).toBe(String(CHAT_ID));
            expect(deliveries()[0]?.body.text).toBe(REPLY_MARKER);
            evidence.admitted = {
              senderId,
              modelRequests: requests.length,
              outboundReplies: 1,
              text: REPLY_MARKER,
            };
            evidence.passed = true;
          } finally {
            const outputDir = path.join(
              repoRoot,
              ".artifacts/qa-e2e/telegram-inherited-policy",
              String(evidence.head),
              groupPolicy,
            );
            try {
              evidence.rejectionLog =
                gateway
                  ?.logs()
                  .split("\n")
                  .filter((line) => line.includes(REJECTION)) ?? [];
              evidence.modelRequests = (await modelRequests()).map((request) => ({
                requestKind: request.requestKind,
                outcome: request.outcome,
                admittedMarker: request.allInputText.includes(REPLY_MARKER),
                rejectedMarker: request.allInputText.includes(REJECTED_MARKER),
              }));
              evidence.inflightRequests = (await inflightRequests()).length;
              evidence.outboundReplies = deliveries().map((call) => ({
                chatId: call.body.chat_id,
                text: call.body.text,
              }));
              evidence.telegramSessions = gateway ? await telegramSessions() : [];
              await fs.mkdir(outputDir, { recursive: true });
              await fs.writeFile(
                path.join(outputDir, "verdict.json"),
                `${JSON.stringify(evidence, null, 2)}\n`,
              );
              console.log(`TELEGRAM_AUTHORITY_CHAIN ${JSON.stringify(evidence)}`);
            } finally {
              try {
                await stopQaGatewayFixture(gatewayOwner, {
                  preserveToDir: path.join(outputDir, "gateway"),
                });
              } finally {
                await mock.stop();
              }
            }
          }
        }),
    );
  },
  180_000,
);
