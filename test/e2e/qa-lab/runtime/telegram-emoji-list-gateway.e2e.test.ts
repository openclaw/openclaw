import type { IncomingMessage, ServerResponse } from "node:http";
import { withServer, withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, test } from "vitest";
import {
  type MockOpenAiRequestSnapshot,
  createQaGatewayChild,
  startQaMockOpenAiServer,
  writeJson,
} from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  readTelegramRequest as readRequest,
  bindTelegramProof,
  telegramProofChannel,
  forwardTelegramProvider,
  telegramRequestHandler,
  mapTelegramSse,
  createTelegramApi,
  settleTelegramCleanup as settleCleanup,
  telegramGatewayOptions,
} from "./telegram-gateway.test-support.js";

type JsonObject = Record<string, unknown>;

const BOT_TOKEN = `424242:${"A".repeat(35)}`;
const CURRENT_CHAT_ID = 2468;
const FOREIGN_CHAT_ID = 97531;
const CUSTOM_EMOJI_ID = "5368324170671202286";
const CURRENT_CHAT_SCENARIO = "TELEGRAM_EMOJI_LIST_CURRENT_CHAT";
const FOREIGN_CHAT_SCENARIO = "TELEGRAM_EMOJI_LIST_FOREIGN_CHAT";
const CONVERSATION_BINDING_ERROR =
  "Delegated Telegram conversation read requires the exact current chat and account.";

function inboundUpdate(updateId: number, scenario: string) {
  return {
    update_id: updateId,
    message: {
      message_id: 9000 + updateId,
      date: 1_754_000_000,
      chat: { id: CURRENT_CHAT_ID, type: "private" },
      from: { id: CURRENT_CHAT_ID, is_bot: false, first_name: "QA" },
      text: `QA group visible reply tool check: ${scenario}`,
    },
  };
}

function scriptMessageToolCall(payload: string, args: JsonObject) {
  let scripted = false;
  const argumentsText = JSON.stringify(args);
  const finishAssistantMessage = (item: JsonObject | undefined) => {
    if (item?.type !== "message" || !Array.isArray(item.content)) {
      return;
    }
    for (const part of item.content as JsonObject[]) {
      if (part.type === "output_text" && part.text === "") {
        // The shared group-reply fixture ends empty; finish the turn so recovery never repeats discovery.
        part.text = "Emoji discovery complete.";
      }
    }
  };
  const scriptedPayload = mapTelegramSse(payload, (event) => {
    if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
      const item = event.item as JsonObject | undefined;
      if (item?.name === "message") {
        scripted = true;
        if (item.arguments !== "") {
          item.arguments = argumentsText;
        }
      }
      finishAssistantMessage(item);
    } else if (event.type === "response.function_call_arguments.delta" && scripted) {
      event.delta = argumentsText;
    } else if (event.type === "response.function_call_arguments.done" && scripted) {
      event.arguments = argumentsText;
    } else if (event.type === "response.completed") {
      const response = event.response as JsonObject | undefined;
      const output = response?.output;
      if (Array.isArray(output)) {
        for (const item of output as JsonObject[]) {
          if (item.name === "message") {
            item.arguments = argumentsText;
            scripted = true;
          }
          finishAssistantMessage(item);
        }
      }
    }
  });
  return { payload: scriptedPayload, scripted };
}

test("binds Telegram emoji discovery to the current conversation before Bot API I/O", async () => {
  const api = createTelegramApi({
    token: BOT_TOKEN,
    bot: { id: 424242, is_bot: true, first_name: "QA Emoji", username: "qa_emoji_bot" },
    chat: { id: CURRENT_CHAT_ID, type: "private" },
    messageId: (callCount) => 10_000 + callCount,
    chatDetails: {
      first_name: "QA",
      available_reactions: [
        { type: "emoji", emoji: "👍" },
        { type: "custom_emoji", custom_emoji_id: CUSTOM_EMOJI_ID },
      ],
    },
  });
  const telegramCalls = api.calls;
  const scriptedCalls: Array<{ scenario: string; arguments: JsonObject }> = [];
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
    const raw = await readRequest(req);
    const upstream = await forwardTelegramProvider(req, mock.baseUrl, pathname, raw);
    let payload = await upstream.text();
    const currentScenarioIndex = raw.lastIndexOf(CURRENT_CHAT_SCENARIO);
    const foreignScenarioIndex = raw.lastIndexOf(FOREIGN_CHAT_SCENARIO);
    const scenario =
      foreignScenarioIndex > currentScenarioIndex
        ? FOREIGN_CHAT_SCENARIO
        : currentScenarioIndex >= 0
          ? CURRENT_CHAT_SCENARIO
          : undefined;

    if (pathname === "/v1/responses" && scenario) {
      const args = {
        action: "emoji-list",
        ...(scenario === FOREIGN_CHAT_SCENARIO ? { chatId: String(FOREIGN_CHAT_ID) } : {}),
      };
      const scripted = scriptMessageToolCall(payload, args);
      payload = scripted.payload;
      if (scripted.scripted) {
        scriptedCalls.push({ scenario, arguments: args });
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
      return;
    }

    await api.handle(req, res);
  };

  await withServer(telegramRequestHandler(handleRequest), async (apiRoot) => {
    return await withTempDir("openclaw-telegram-emoji-list-", async (workspace) => {
      const gatewayOwner = createQaGatewayChild();
      try {
        mock = await startQaMockOpenAiServer();
        await gatewayOwner.start(
          telegramGatewayOptions({
            workspace,
            apiRoot,
            providerBaseUrl: `${apiRoot}/v1`,
            mockSessionObserverUrl: mock.sessionObserverUrl,
            telegram: telegramProofChannel(apiRoot, BOT_TOKEN, {
              dmPolicy: "open",
              allowFrom: ["*"],
              commands: { native: false },
            }),
            runtimeEnvPatch: {
              OPENCLAW_SKIP_CHANNELS: undefined,
              OPENCLAW_SKIP_PROVIDERS: undefined,
            },
            mutateConfig: (cfg) => {
              cfg.agents!.entries!.qa!.tools = { profile: "full" };
              cfg.tools = { ...cfg.tools, profile: "full", toolSearch: false, codeMode: false };
              bindTelegramProof(cfg);
              return cfg;
            },
          }),
        );

        const findToolResult = async (scenario: string) => {
          const response = await fetch(`${mock!.baseUrl}/debug/requests`);
          expect(response.ok).toBe(true);
          const requests = (await response.json()) as MockOpenAiRequestSnapshot[];
          return requests.find(
            (request) => request.prompt.includes(scenario) && request.toolOutput.length > 0,
          );
        };

        api.updates.enqueue(inboundUpdate(1, CURRENT_CHAT_SCENARIO));
        await expect
          .poll(
            async () => ({
              request: await findToolResult(CURRENT_CHAT_SCENARIO),
              scriptedCalls,
            }),
            {
              interval: 50,
              timeout: 30_000,
            },
          )
          .toMatchObject({
            request: { toolOutput: expect.stringContaining(CUSTOM_EMOJI_ID) },
            scriptedCalls: [
              { scenario: CURRENT_CHAT_SCENARIO, arguments: { action: "emoji-list" } },
            ],
          });

        const currentChatResult = await findToolResult(CURRENT_CHAT_SCENARIO);
        expect(JSON.parse(currentChatResult!.toolOutput)).toMatchObject({
          ok: true,
          emojis: [
            { name: "👍", identifier: "👍" },
            { identifier: CUSTOM_EMOJI_ID, type: "custom_emoji" },
          ],
        });
        expect(
          telegramCalls.filter(
            (call) =>
              call.method === "getChat" && String(call.body.chat_id) === String(CURRENT_CHAT_ID),
          ),
        ).toHaveLength(1);

        api.updates.enqueue(inboundUpdate(2, FOREIGN_CHAT_SCENARIO));
        await expect
          .poll(() => findToolResult(FOREIGN_CHAT_SCENARIO), {
            interval: 50,
            timeout: 30_000,
          })
          .toMatchObject({ toolOutput: expect.stringContaining(CONVERSATION_BINDING_ERROR) });

        expect(
          telegramCalls.filter((call) => JSON.stringify(call).includes(String(FOREIGN_CHAT_ID))),
        ).toEqual([]);
        expect(scriptedCalls).toEqual([
          { scenario: CURRENT_CHAT_SCENARIO, arguments: { action: "emoji-list" } },
          {
            scenario: FOREIGN_CHAT_SCENARIO,
            arguments: { action: "emoji-list", chatId: String(FOREIGN_CHAT_ID) },
          },
        ]);
      } finally {
        await settleCleanup(
          async () => await stopQaGatewayFixture(gatewayOwner),
          async () => await mock?.stop(),
        );
      }
    });
  });
}, 120_000);
