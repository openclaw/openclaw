// Root-owned integration: core's message-action runner in front of the public Telegram plugin.
import { createServer } from "node:http";
import {
  createEmptyPluginRegistry,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withStateDirEnv } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { telegramPlugin } from "../extensions/telegram/api.js";
import { runMessageAction } from "../src/infra/outbound/message-action-runner.js";
import { listenLoopback, readBody, replyJson } from "./telegram-http.test-support.js";

beforeEach(() => {
  // This synthetic Bot API must not use an ambient outbound HTTP proxy.
  vi.stubEnv("NO_PROXY", "127.0.0.1,localhost,::1");
  vi.stubEnv("no_proxy", "127.0.0.1,localhost,::1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
});

const presentation = (value: string) => ({
  blocks: [
    {
      type: "buttons",
      buttons: [
        { label: "Typed", action: { type: "callback", value } },
        // Legacy values keep their 64-byte budget minus the 2-byte mark.
        { label: "Legacy", value: "x".repeat(62) },
      ],
    },
  ],
});

it("sends message-action callbacks with the agent mark on the send and edit paths", async () => {
  const keyboards: Array<{ method: string; data: string[] }> = [];
  const botApi = await listenLoopback(
    createServer((request, response) => {
      readBody(request, (body) => {
        const method = request.url?.split("/").at(-1) ?? "";
        const fields = body ? JSON.parse(body) : {};
        const rows = fields.reply_markup?.inline_keyboard as
          | Array<Array<{ callback_data: string }>>
          | undefined;
        if (rows) {
          keyboards.push({ method, data: rows.flat().map((button) => button.callback_data) });
        }
        replyJson(response, {
          ok: true,
          result: { message_id: 7, date: 1, chat: { id: 123, type: "private" }, text: "Pick" },
        });
      });
    }),
  );
  try {
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "telegram", plugin: telegramPlugin, source: "test" }]),
    );
    const cfg = {
      channels: { telegram: { botToken: "123456:agent-controls", apiRoot: botApi.url } },
    } satisfies OpenClawConfig;
    await withStateDirEnv("openclaw-telegram-agent-controls-", async () => {
      // Core-forced delivery (the queue-persistence path) skips Telegram's prepareSendPayload hook.
      await runMessageAction({
        cfg,
        action: "send",
        params: {
          channel: "telegram",
          to: "123",
          message: "Pick",
          presentation: presentation("/pick a|1"),
        },
        forceCoreDelivery: true,
        skipQueue: true,
      });
      await runMessageAction({
        cfg,
        action: "edit",
        params: {
          channel: "telegram",
          to: "123",
          messageId: "7",
          message: "Pick again",
          presentation: presentation("pick:b"),
        },
        conversationReadOrigin: "direct-operator",
      });
    });
  } finally {
    await botApi.close();
  }
  const legacy = `::${"x".repeat(62)}`;
  expect(keyboards).toEqual([
    { method: "sendMessage", data: ["::/pick a|1", legacy] },
    { method: "editMessageText", data: ["::pick:b", legacy] },
  ]);
});
