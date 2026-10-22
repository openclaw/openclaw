import type { IncomingMessage, ServerResponse } from "node:http";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { expect, test } from "vitest";
import type { ModelProviderConfig } from "../../src/config/types.models.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { SessionsListResult } from "../../src/gateway/session-utils.types.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
} from "../../src/gateway/test-helpers.e2e.js";
import { readRequestText, respondJson } from "../helpers/gateway-integration-fixtures.js";
import { createOpenClawTestInstance } from "../helpers/openclaw-test-instance.js";

const PROVIDER = "provider-with-a-long-name";
const REPLACEMENT = "replacement-provider";
const MODEL = `shared-model-${"x".repeat(35)}`;
const MODEL_REF = `${PROVIDER}/${MODEL}`;
const REPLACEMENT_REF = `${REPLACEMENT}/${MODEL}`;
const BASELINE = "anchor/baseline";
const SESSION_KEY = "agent:main:main";
const CHAT = { id: 2468, type: "private" };
const USER = { id: 1357, is_bot: false, first_name: "Picker tester" };
const BOT = { id: 424242, is_bot: true, first_name: "Picker", username: "picker_test_bot" };
const WAIT = { timeout: 30_000, interval: 50 };
const apiReplies: Record<string, unknown> = {
  getMe: BOT,
  getChat: CHAT,
  getWebhookInfo: { url: "", pending_update_count: 0 },
  deleteWebhook: true,
  setMyCommands: true,
  deleteMyCommands: true,
  answerCallbackQuery: true,
  sendChatAction: true,
};

type Keyboard = Array<Array<{ text: string; callback_data: string }>>;
type Message = ReturnType<typeof makeMessage>;
type ApiBody = {
  text?: string;
  reply_markup?: { inline_keyboard: Keyboard };
  message_id?: number;
  callback_query_id?: string;
};
type ApiCall = { method: string; body: ApiBody };

function makeMessage(
  message_id: number,
  from: typeof USER,
  text: string,
  reply_markup: { inline_keyboard: Keyboard } = { inline_keyboard: [] },
) {
  return { message_id, date: Math.floor(Date.now() / 1000), chat: CHAT, from, text, reply_markup };
}

function modelButton(message: Message) {
  return message.reply_markup.inline_keyboard
    .flat()
    .find(({ callback_data: data }) => data.startsWith("mdl_sel") || data.startsWith("mdl1~m:"));
}

function providerConfig(baseUrl: string, id: string): ModelProviderConfig {
  return {
    baseUrl,
    api: "openai-completions",
    apiKey: "synthetic-picker-key",
    models: [
      {
        id,
        name: id,
        contextWindow: 8192,
        maxTokens: 256,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  };
}

test("keeps an emitted model button bound to its provider after inventory replacement", async () => {
  const calls: ApiCall[] = [];
  const messages = new Map<number, Message>();
  const updates: Array<Record<string, unknown>> = [];
  let pendingPoll: ServerResponse | undefined;
  let updateId = 0;
  let messageId = 9000;
  const succeed = (response: ServerResponse, result: unknown) => {
    respondJson(response, { ok: true, result });
  };
  const enqueue = (update: Record<string, unknown>) => {
    updates.push({ update_id: ++updateId, ...update });
    if (pendingPoll) {
      succeed(pendingPoll, updates.splice(0));
      pendingPoll = undefined;
    }
  };
  const command = () =>
    enqueue({
      message: {
        message_id: ++messageId,
        date: Math.floor(Date.now() / 1000),
        chat: CHAT,
        from: USER,
        text: `/models ${PROVIDER}`,
        entities: [{ type: "bot_command", offset: 0, length: "/models".length }],
      },
    });
  const click = (message: Message, data: string, id: string) =>
    enqueue({
      callback_query: { id, from: USER, chat_instance: "picker-identity", message, data },
    });
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const raw = await readRequestText(request);
    const body: ApiBody = raw ? JSON.parse(raw) : {};
    const method = request.url?.split("/").at(-1) ?? "";
    calls.push({ method, body });
    if (method === "getUpdates") {
      if (updates.length > 0) {
        succeed(response, updates.splice(0));
      } else {
        pendingPoll = response;
        response.once("close", () => {
          if (pendingPoll === response) {
            pendingPoll = undefined;
          }
        });
      }
    } else if (Object.hasOwn(apiReplies, method)) {
      succeed(response, apiReplies[method]);
    } else if (["sendMessage", "editMessageText", "editMessageReplyMarkup"].includes(method)) {
      const previous = body.message_id ? messages.get(body.message_id) : undefined;
      const message = makeMessage(
        body.message_id ?? ++messageId,
        BOT,
        body.text ?? previous?.text ?? "",
        body.reply_markup ?? previous?.reply_markup,
      );
      messages.set(message.message_id, message);
      succeed(response, message);
    } else {
      respondJson(response, { ok: false, error_code: 404, description: method }, 404);
    }
  };

  await withServer(
    (request, response) => {
      void handle(request, response).catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    },
    async (apiRoot) => {
      const config = {
        gateway: { mode: "local" },
        session: { dmScope: "main" },
        plugins: {
          allow: ["telegram"],
          entries: { telegram: { enabled: true } },
          slots: { memory: "none" },
        },
        channels: {
          telegram: {
            enabled: true,
            botToken: "424242:picker-identity-test",
            apiRoot,
            dmPolicy: "open",
            allowFrom: ["*"],
            commands: { native: true },
          },
        },
        agents: {
          defaults: {
            model: BASELINE,
            models: { [BASELINE]: {}, [MODEL_REF]: {} },
            modelPolicy: { allow: [BASELINE, MODEL_REF] },
          },
        },
        models: {
          mode: "replace",
          providers: {
            anchor: providerConfig(apiRoot, "baseline"),
            [PROVIDER]: providerConfig(apiRoot, MODEL),
          },
        },
      } satisfies OpenClawConfig;
      const instance = await createOpenClawTestInstance({
        name: "telegram-picker-identity",
        config,
        env: {
          OPENCLAW_SKIP_CHANNELS: undefined,
          OPENCLAW_SKIP_PROVIDERS: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        },
      });
      try {
        await instance.startGateway();
        const client = await connectGatewayClient({
          url: instance.url,
          token: instance.gatewayToken,
          role: "operator",
          scopes: ["operator.admin", "operator.read", "operator.write"],
        });
        try {
          const selection = async () => {
            const result = await client.request<SessionsListResult>("sessions.list", {
              agentId: "main",
            });
            const session = result.sessions.find((row) => row.key === SESSION_KEY);
            return { provider: session?.modelProvider, model: session?.model };
          };
          const openPicker = async () => {
            const start = messageId;
            command();
            let picked: { message: Message; data: string } | undefined;
            await expect
              .poll(() => {
                const message = [...messages.values()].find(
                  (entry) => entry.message_id > start && modelButton(entry),
                );
                const button = message && modelButton(message);
                return (picked =
                  message && button ? { message, data: button.callback_data } : undefined);
              }, WAIT)
              .toBeDefined();
            return picked!;
          };
          await expect
            .poll(() => calls.some((call) => call.method === "getUpdates"), WAIT)
            .toBe(true);
          await client.request("sessions.patch", { key: SESSION_KEY, model: BASELINE });
          const control = await openPicker();
          click(control.message, control.data, "unchanged-inventory");
          await expect.poll(selection, WAIT).toEqual({ provider: PROVIDER, model: MODEL });
          expect(calls).toContainEqual({
            method: "answerCallbackQuery",
            body: { callback_query_id: "unchanged-inventory" },
          });
          await client.request("sessions.patch", { key: SESSION_KEY, model: BASELINE });
          const captured = await openPicker();
          const before = await selection();
          const snapshot = await client.request<{ hash: string }>("config.get", {});
          await client.request("config.patch", {
            baseHash: snapshot.hash,
            replacePaths: [
              `models.providers.${PROVIDER}.models`,
              "agents.defaults.modelPolicy.allow",
            ],
            raw: JSON.stringify({
              models: {
                providers: { [PROVIDER]: null, [REPLACEMENT]: providerConfig(apiRoot, MODEL) },
              },
              agents: {
                defaults: {
                  models: { [MODEL_REF]: null, [REPLACEMENT_REF]: {} },
                  modelPolicy: { allow: [BASELINE, REPLACEMENT_REF] },
                },
              },
            }),
          });
          await expect
            .poll(async () => {
              const result = await client.request<{
                models: Array<{ provider: string; id: string }>;
              }>("models.list", { view: "default" });
              return result.models
                .filter((model) => model.id === MODEL)
                .map((model) => model.provider);
            }, WAIT)
            .toEqual([REPLACEMENT]);
          const callStart = calls.length;
          click(captured.message, captured.data, "replaced-inventory");
          await expect
            .poll(
              () => calls.slice(callStart).find((call) => call.method === "editMessageText"),
              WAIT,
            )
            .toBeDefined();
          expect(calls.slice(callStart)).toContainEqual({
            method: "answerCallbackQuery",
            body: { callback_query_id: "replaced-inventory" },
          });
          expect(await selection()).toEqual(before);
          const replacement = messages.get(captured.message.message_id);
          expect(replacement?.text).toBe(
            "Available models changed. Open /models and choose again.",
          );
          expect(replacement?.reply_markup.inline_keyboard.flat()).toContainEqual({
            text: `${REPLACEMENT} (1)`,
            callback_data: `mdl_list_${REPLACEMENT}_1`,
          });
        } finally {
          await disconnectGatewayClient(client);
        }
      } catch (error) {
        throw new Error(`${String(error)}\n${instance.logs()}\n${JSON.stringify(calls)}`, {
          cause: error,
        });
      } finally {
        await instance.cleanup();
      }
    },
  );
}, 180_000);
