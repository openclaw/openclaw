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
import { createOpenClawTestInstance } from "../helpers/openclaw-test-instance.js";

const PROVIDER = "provider-with-a-long-name";
const REPLACEMENT = "replacement-provider";
const MODEL = `shared-model-${"x".repeat(35)}`;
const SESSION_KEY = "agent:main:main";
const CHAT = { id: 2468, type: "private" };
const USER = { id: 1357, is_bot: false, first_name: "Picker tester" };
const BOT = { id: 424242, is_bot: true, first_name: "Picker", username: "picker_test_bot" };
const WAIT = { timeout: 30_000, interval: 50 };

type Keyboard = Array<Array<{ text: string; callback_data: string }>>;
type Message = {
  message_id: number;
  date: number;
  chat: typeof CHAT;
  from: typeof BOT;
  text: string;
  reply_markup: { inline_keyboard: Keyboard };
};
type ApiBody = {
  text?: string;
  reply_markup?: { inline_keyboard: Keyboard };
  message_id?: number;
  callback_query_id?: string;
  offset?: number;
};
type ApiCall = { method: string; body: ApiBody };

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
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result }));
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
    let raw = "";
    for await (const chunk of request) {
      raw += chunk;
    }
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
    } else if (method === "getMe") {
      succeed(response, BOT);
    } else if (method === "getChat") {
      succeed(response, CHAT);
    } else if (method === "getWebhookInfo") {
      succeed(response, { url: "", pending_update_count: 0 });
    } else if (["sendMessage", "editMessageText", "editMessageReplyMarkup"].includes(method)) {
      const previous = body.message_id ? messages.get(body.message_id) : undefined;
      const message: Message = {
        message_id: body.message_id ?? ++messageId,
        date: Math.floor(Date.now() / 1000),
        chat: CHAT,
        from: BOT,
        text: body.text ?? previous?.text ?? "",
        reply_markup: body.reply_markup ?? previous?.reply_markup ?? { inline_keyboard: [] },
      };
      messages.set(message.message_id, message);
      succeed(response, message);
    } else if (
      [
        "deleteWebhook",
        "setMyCommands",
        "deleteMyCommands",
        "answerCallbackQuery",
        "sendChatAction",
      ].includes(method)
    ) {
      succeed(response, true);
    } else {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error_code: 404, description: method }));
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
            model: "anchor/baseline",
            models: { "anchor/baseline": {}, [`${PROVIDER}/${MODEL}`]: {} },
            modelPolicy: { allow: ["anchor/baseline", `${PROVIDER}/${MODEL}`] },
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
            await expect
              .poll(
                () =>
                  [...messages.values()].some(
                    (message) =>
                      message.message_id > start &&
                      message.reply_markup.inline_keyboard
                        .flat()
                        .some(
                          (button) =>
                            button.callback_data.startsWith("mdl_sel") ||
                            button.callback_data.startsWith("mdl1~m:"),
                        ),
                  ),
                WAIT,
              )
              .toBe(true);
            const keyboardMessage = [...messages.values()].find(
              (message) =>
                message.message_id > start &&
                message.reply_markup.inline_keyboard
                  .flat()
                  .some(
                    (button) =>
                      button.callback_data.startsWith("mdl_sel") ||
                      button.callback_data.startsWith("mdl1~m:"),
                  ),
            );
            if (!keyboardMessage) {
              throw new Error("Gateway did not emit a model keyboard");
            }
            const modelButton = keyboardMessage.reply_markup.inline_keyboard
              .flat()
              .find(
                (button) =>
                  button.callback_data.startsWith("mdl_sel") ||
                  button.callback_data.startsWith("mdl1~m:"),
              );
            if (!modelButton) {
              throw new Error("Gateway did not emit a model button");
            }
            return { message: keyboardMessage, data: modelButton.callback_data };
          };
          await expect
            .poll(() => calls.some((call) => call.method === "getUpdates"), WAIT)
            .toBe(true);
          await client.request("sessions.patch", { key: SESSION_KEY, model: "anchor/baseline" });
          const control = await openPicker();
          click(control.message, control.data, "unchanged-inventory");
          await expect.poll(selection, WAIT).toEqual({ provider: PROVIDER, model: MODEL });
          expect(calls).toContainEqual({
            method: "answerCallbackQuery",
            body: { callback_query_id: "unchanged-inventory" },
          });
          await client.request("sessions.patch", { key: SESSION_KEY, model: "anchor/baseline" });
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
                  models: { [`${PROVIDER}/${MODEL}`]: null, [`${REPLACEMENT}/${MODEL}`]: {} },
                  modelPolicy: { allow: ["anchor/baseline", `${REPLACEMENT}/${MODEL}`] },
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
