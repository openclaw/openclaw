import type { IncomingMessage, ServerResponse } from "node:http";
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
import {
  createTelegramApi,
  readTelegramRequest,
  telegramGatewayOptions,
  settleTelegramCleanup as settleCleanup,
} from "./telegram-gateway.test-support.js";

type JsonObject = Record<string, unknown>;

const BOT_ID = 424242;
const BOT_TOKEN = `${BOT_ID}:${"A".repeat(35)}`;
const CHAT_ID = -1002468135790;
const ROOM_TITLE = "Harbor Conservation Crew";
const ROOM_DESCRIPTION = "organizing shoreline cleanups and monitoring tide-pool habitats";
const UNAVAILABLE_HISTORY_FACT = "Earlier room messages cannot be read on this platform.";
const bot = { id: BOT_ID, is_bot: true, first_name: "QA Harbor", username: "qa_harbor_bot" };
const chat = { id: CHAT_ID, type: "supergroup", title: ROOM_TITLE };

function joinUpdate() {
  return {
    update_id: 1,
    my_chat_member: {
      chat,
      from: { id: 1357, is_bot: false, first_name: "Harbor Organizer" },
      date: 1_754_000_000,
      old_chat_member: { status: "left", user: bot },
      new_chat_member: { status: "member", user: bot },
    },
  };
}

function groundAssistantResponse(payload: string, text: string) {
  let grounded = false;
  let emittedDelta = false;
  const updateOutputItem = (item: unknown) => {
    if (!item || typeof item !== "object") {
      return;
    }
    const content = (item as JsonObject).content;
    if (!Array.isArray(content)) {
      return;
    }
    for (const part of content) {
      if (part && typeof part === "object" && (part as JsonObject).type === "output_text") {
        (part as JsonObject).text = text;
        grounded = true;
      }
    }
  };

  const rewritten = payload
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data: ") || line === "data: [DONE]") {
        return line;
      }
      const event = JSON.parse(line.slice(6)) as JsonObject;
      if (event.type === "response.output_text.delta") {
        event.delta = emittedDelta ? "" : text;
        emittedDelta = true;
        grounded = true;
      } else if (event.type === "response.output_text.done") {
        event.text = text;
        grounded = true;
      } else if (
        event.type === "response.output_item.added" ||
        event.type === "response.output_item.done"
      ) {
        updateOutputItem(event.item);
      } else if (event.type === "response.completed") {
        const output = (event.response as JsonObject | undefined)?.output;
        if (Array.isArray(output)) {
          for (const item of output) {
            updateOutputItem(item);
          }
        }
      }
      return `data: ${JSON.stringify(event)}`;
    })
    .join("\n");

  return { payload: rewritten, grounded };
}

test("introduces itself once when Telegram reports joining an allowed supergroup", async () => {
  const api = createTelegramApi({
    token: BOT_TOKEN,
    bot,
    chat,
    chatDetails: { description: ROOM_DESCRIPTION },
  });
  const { calls: telegramCalls, updates } = api;
  const { pendingUpdates, pendingPolls } = updates;
  let groundedModelResponses = 0;
  let providerRequests = 0;
  let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;

  const proxyProviderRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ) => {
    if (!mock) {
      writeJson(res, 503, { error: "mock provider is not ready" });
      return;
    }
    providerRequests += 1;
    const raw = await readTelegramRequest(req);
    const upstream = await fetch(`${mock.baseUrl}${pathname}`, {
      method: req.method,
      ...(raw ? { body: raw } : {}),
      headers: {
        "content-type": "application/json",
        ...(typeof req.headers.session_id === "string"
          ? { session_id: req.headers.session_id }
          : {}),
        ...(typeof req.headers["x-session-affinity"] === "string"
          ? { "x-session-affinity": req.headers["x-session-affinity"] }
          : {}),
      },
    });
    let payload = await upstream.text();
    if (
      pathname === "/v1/responses" &&
      raw.includes(ROOM_TITLE) &&
      raw.includes(ROOM_DESCRIPTION) &&
      raw.includes(UNAVAILABLE_HISTORY_FACT)
    ) {
      const groundedResponse = groundAssistantResponse(
        payload,
        `${ROOM_TITLE} is ${ROOM_DESCRIPTION}. I can organize cleanup plans and track habitat observations.`,
      );
      payload = groundedResponse.payload;
      if (groundedResponse.grounded) {
        groundedModelResponses += 1;
      }
    }
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
    });
    res.end(payload);
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname.startsWith("/v1/")) {
      await proxyProviderRequest(req, res, pathname);
    } else {
      await api.handle(req, res);
    }
  };

  await withServer(
    (req, res) => {
      void handleRequest(req, res).catch((error: unknown) => {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
    },
    async (apiRoot) => {
      return await withTempDir("openclaw-telegram-join-intro-", async (workspace) => {
        const gatewayOwner = createQaGatewayChild();
        let gateway: QaGatewayChild | undefined;
        try {
          mock = await startQaMockOpenAiServer();
          gateway = await gatewayOwner.start(
            telegramGatewayOptions({
              workspace,
              apiRoot,
              providerBaseUrl: `${apiRoot}/v1`,
              mockSessionObserverUrl: mock.sessionObserverUrl,
              telegram: {
                enabled: true,
                defaultAccount: "proof",
                groupPolicy: "open",
                accounts: {
                  proof: {
                    enabled: true,
                    botToken: BOT_TOKEN,
                    apiRoot,
                    groupPolicy: "open",
                    commands: { native: false },
                  },
                },
              },
              runtimeEnvPatch: {
                OPENCLAW_SKIP_CHANNELS: undefined,
                OPENCLAW_SKIP_PROVIDERS: undefined,
              },
              mutateConfig: (cfg) => {
                cfg.bindings = [
                  ...(cfg.bindings ?? []),
                  { agentId: "qa", match: { channel: "telegram", accountId: "proof" } },
                ];
                return cfg;
              },
            }),
          );

          updates.enqueue(joinUpdate());
          await expect
            .poll(
              () => ({
                deliveries: telegramCalls
                  .filter((call) => call.method === "sendMessage")
                  .map((call) => ({ chatId: String(call.body.chat_id), text: call.body.text })),
                groundedModelResponses,
                telegramMethods: telegramCalls.map((call) => call.method),
              }),
              { interval: 50, timeout: 30_000 },
            )
            .toMatchObject({
              deliveries: [
                {
                  chatId: String(CHAT_ID),
                  text: expect.stringContaining(ROOM_TITLE),
                },
              ],
              groundedModelResponses: 1,
            })
            .catch((error: unknown) => {
              const diagnostics = {
                telegramCalls,
                providerRequests,
                groundedModelResponses,
                pendingUpdateCount: pendingUpdates.length,
                pendingPollCount: pendingPolls.size,
                gatewayLogs: gateway?.logs().slice(-12_000),
              };
              throw new Error(
                `Telegram join introduction did not reach its native delivery boundary:\n${JSON.stringify(diagnostics, null, 2)}`,
                { cause: error },
              );
            });

          const deliveries = telegramCalls.filter((call) => call.method === "sendMessage");
          expect(deliveries).toHaveLength(1);
          expect(String(deliveries[0]?.body.chat_id)).toBe(String(CHAT_ID));
          expect(deliveries[0]?.body.text).toEqual(expect.stringContaining(ROOM_TITLE));
          expect(deliveries[0]?.body.text).toEqual(expect.stringContaining(ROOM_DESCRIPTION));
          expect(
            telegramCalls.filter(
              (call) => call.method === "getChat" && String(call.body.chat_id) === String(CHAT_ID),
            ),
          ).toHaveLength(1);

          const requestResponse = await fetch(`${mock.baseUrl}/debug/requests`);
          expect(requestResponse.ok).toBe(true);
          const modelRequests = (await requestResponse.json()) as MockOpenAiRequestSnapshot[];
          const introRequest = modelRequests.find((request) =>
            request.allInputText.includes(ROOM_TITLE),
          );
          expect(introRequest?.allInputText).toEqual(expect.stringContaining(ROOM_DESCRIPTION));
          expect(introRequest?.allInputText).toEqual(
            expect.stringContaining(UNAVAILABLE_HISTORY_FACT),
          );
        } finally {
          await settleCleanup(
            async () => await stopQaGatewayFixture(gatewayOwner),
            async () => await mock?.stop(),
          );
        }
      });
    },
  );
}, 120_000);
