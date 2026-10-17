// A message-tool send dispatched through the gateway to the real Telegram action
// handler must reach the Bot API as an agent-owned callback button.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  agentRuntimeClientForTests,
  directCliClientForTests,
  firstRespondCall,
} from "./send.test-helpers.js";
import { makeContext } from "./send.test-support.js";
import type { GatewayRequestHandler, RespondFn } from "./types.js";

const TOKEN = "123456:message-tool-callback-ownership";
const CHAT_ID = "123";
const SESSION_KEY = `agent:main:telegram:direct:${CHAT_ID}`;
type InlineKeyboard = { inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>> };

let telegramPlugin: ChannelPlugin;
let messageActionHandler: GatewayRequestHandler;
let server: Server | undefined;

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

beforeAll(async () => {
  const { sendHandlers } = await import("./send.js");
  messageActionHandler = expectDefined(
    sendHandlers["message.action"],
    "registered Gateway message.action handler",
  );
  ({ telegramPlugin } = await loadBundledPluginFacade<{ telegramPlugin: ChannelPlugin }>({
    pluginId: "telegram",
    artifactBasename: "api.js",
  }));
});

afterEach(async () => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(createEmptyPluginRegistry());
  clearRuntimeConfigSnapshot();
  await new Promise<void>((resolve) => {
    server?.close(() => resolve());
    server = undefined;
  });
});

async function startBotApi() {
  const sent: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const method = request.url?.split("/").at(-1) ?? "";
    const payload = await readJsonBody(request);
    sent.push({ method, payload });
    response.writeHead(200, { "content-type": "application/json", connection: "close" });
    response.end(
      JSON.stringify({
        ok: true,
        result:
          method === "sendMessage"
            ? { message_id: 7, date: 1, chat: { id: Number(CHAT_ID), type: "private" } }
            : true,
      }),
    );
  };
  server = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve) => {
    server!.listen(0, "127.0.0.1", resolve);
  });
  const apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { sent, apiRoot };
}

function sentCallbackData(sent: Array<{ method: string; payload: Record<string, unknown> }>) {
  const message = sent.find((entry) => entry.method === "sendMessage");
  expect(message, `Bot API calls: ${sent.map((entry) => entry.method).join(", ")}`).toBeDefined();
  const raw = message!.payload.reply_markup;
  const markup = (typeof raw === "string" ? JSON.parse(raw) : raw) as InlineKeyboard;
  const button = markup.inline_keyboard?.[0]?.[0];
  expect(button?.text).toBe("Pick");
  return String(button?.callback_data);
}

describe("Gateway message.action send through the registered Telegram action", () => {
  it.each([
    {
      caller: "agent runtime",
      client: () => agentRuntimeClientForTests(SESSION_KEY),
      // Agent-owned envelope; checksum computed independently of the plugin.
      callbackData: "tgac1:1ffnt:btntest_typed",
    },
    {
      caller: "direct CLI",
      client: () => directCliClientForTests(),
      callbackData: "tgcb1:1ffnt:btntest_typed",
    },
  ])(
    "renders a callback button from the $caller as $callbackData",
    async ({ caller, client, callbackData }) => {
      await withOpenClawTestState({ prefix: "message-tool-callback-ownership-" }, async (state) => {
        const { sent, apiRoot } = await startBotApi();
        const cfg: OpenClawConfig = {
          agents: { defaults: { workspace: state.workspaceDir } },
          channels: { telegram: { botToken: TOKEN, apiRoot } },
        };
        await state.writeConfig(cfg);
        setRuntimeConfigSnapshot(cfg, cfg);
        setActivePluginRegistry(
          createTestRegistry([{ pluginId: "telegram", source: "test", plugin: telegramPlugin }]),
        );
        const respond = vi.fn<RespondFn>();
        const context = {
          ...makeContext(),
          getRuntimeConfig: () => cfg,
          validateAgentRuntimeApprovalAuthority: () => true,
        };
        const suffix = caller.replace(/\s+/g, "-");
        await messageActionHandler({
          req: { type: "req", id: suffix, method: "message.action" },
          params: {
            channel: "telegram",
            action: "send",
            params: {
              to: CHAT_ID,
              message: "Proof button",
              presentation: {
                blocks: [
                  {
                    type: "buttons",
                    buttons: [
                      { label: "Pick", action: { type: "callback", value: "btntest_typed" } },
                    ],
                  },
                ],
              },
            },
            ...(caller === "agent runtime" ? { sessionKey: SESSION_KEY, agentId: "main" } : {}),
            idempotencyKey: `message-tool-callback-ownership-${suffix}`,
          } as never,
          context,
          client: client(),
          isWebchatConnect: () => false,
          respond,
          sessionMutationCommitGuard: () => undefined,
        } as never);

        expect(firstRespondCall(respond)[2]).toBeUndefined();
        expect(firstRespondCall(respond)[0]).toBe(true);
        expect(sentCallbackData(sent)).toBe(callbackData);
      });
    },
  );
});
