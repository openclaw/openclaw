import { createServer, type ServerResponse } from "node:http";
import { expect, test } from "vitest";
import { extractCurrentRuntimeContextTexts } from "../extensions/qa-lab/api.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import {
  closeHttpServer,
  listenLoopback,
  readRequestText,
  respondJson,
} from "./helpers/gateway-integration-fixtures.js";
import { writeOpenAiResponsesText } from "./helpers/openai-responses-sse.js";
import { createOpenClawTestInstance } from "./helpers/openclaw-test-instance.js";
import { runQaGatewayFixture } from "./helpers/qa-gateway-cleanup.js";

test("keeps Telegram reply references and selected quotes in real Gateway model requests", async () => {
  const requests: string[] = [];
  const targetText = "[Shared contact] Context fixture, +15550100001";
  const bot = { id: 424242, is_bot: true, first_name: "Reply", username: "reply_proof_bot" };
  const chat = { id: 123, type: "private", first_name: "Fixture" };
  const sent: Array<{
    message_id: number;
    date: number;
    chat: typeof chat;
    text: string;
    from: typeof bot;
  }> = [];
  let poll: ServerResponse | undefined;
  const respond = (response: ServerResponse, result: unknown) =>
    respondJson(response, { ok: true, result });
  const transport = createServer((request, response) => {
    void (async () => {
      const method = request.url?.split("/").at(-1);
      if (method === "getUpdates") {
        poll = response;
        response.on("close", () => {
          if (poll === response) {
            poll = undefined;
          }
        });
        return;
      }
      if (method === "getMe") {
        respond(response, bot);
        return;
      }
      const raw = await readRequestText(request);
      if (request.url === "/v1/responses") {
        requests.push(raw);
        const id = requests.length;
        writeOpenAiResponsesText(response, {
          text: id === 1 ? targetText : `ACK_${id}`,
          messageId: `msg_${id}`,
          responseId: `resp_${id}`,
        });
        return;
      }
      const body = raw ? (JSON.parse(raw) as { text?: string }) : {};
      if (method === "sendMessage") {
        const message = {
          message_id: 2 * sent.length + 2,
          date: Math.floor(Date.now() / 1000),
          chat,
          from: bot,
          text: body.text ?? "",
        };
        sent.push(message);
        respond(response, message);
        return;
      }
      respond(response, true);
    })().catch((error: unknown) => response.writeHead(500).end(String(error)));
  });
  const transportUrl = await listenLoopback(transport);
  const { config: provider } = buildMockOpenAiResponsesProvider(
    `${transportUrl}/v1`,
    "reply-proof",
  );
  provider.apiKey = "test-token-placeholder";
  provider.request = { allowPrivateNetwork: true };
  const instance = await createOpenClawTestInstance({
    name: "telegram-reply-context",
    config: {
      plugins: { slots: { memory: "none" } },
      agents: {
        defaults: {
          model: { primary: "reply-proof/reply-proof" },
          models: { "reply-proof/reply-proof": { agentRuntime: { id: "openclaw" } } },
          skipBootstrap: true,
          skills: [],
        },
      },
      tools: { profile: "minimal" },
      messages: { visibleReplies: "automatic", inbound: { debounceMs: 0 } },
      session: { dmScope: "per-channel-peer" },
      channels: {
        telegram: {
          enabled: true,
          apiRoot: transportUrl,
          botToken: "424242:TEST_TOKEN_PLACEHOLDER_FOR_LOCAL_GATEWAY",
          dmPolicy: "allowlist",
          allowFrom: ["123"],
          dmHistoryLimit: 10,
          commands: { native: false, nativeSkills: false },
          streaming: { mode: "off" },
        },
      },
      models: { mode: "replace", providers: { "reply-proof": provider } },
    },
    env: {
      OPENCLAW_SKIP_CHANNELS: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      TELEGRAM_BOT_TOKEN: undefined,
    },
  });
  await runQaGatewayFixture(
    async () => {
      try {
        await instance.startGateway();
        const turn = async (id: number, extra: Record<string, unknown> = {}) => {
          await expect.poll(() => Boolean(poll), { timeout: 30000 }).toBe(true);
          const currentPoll = poll!;
          poll = undefined;
          respond(currentPoll, [
            {
              update_id: id,
              message: {
                message_id: 2 * id - 1,
                date: Math.floor(Date.now() / 1000),
                from: { id: 123, is_bot: false, first_name: "Fixture" },
                chat,
                text: `TURN_${id}: Please continue.`,
                ...extra,
              },
            },
          ]);
          await expect.poll(() => sent.length, { timeout: 30000 }).toBe(id);
          expect(sent[id - 1]!.text).toBe(id === 1 ? targetText : `ACK_${id}`);
          expect(requests).toHaveLength(id);
          const request = JSON.parse(requests.at(-1)!) as {
            input: Parameters<typeof extractCurrentRuntimeContextTexts>[0];
          };
          return extractCurrentRuntimeContextTexts(request.input).join("\n\n");
        };
        await turn(1);
        const target = sent[0]!;
        const ordinary = await turn(2, { reply_to_message: target });
        expect(ordinary.split(target.text)).toHaveLength(2);
        expect(ordinary).toContain(`#${target.message_id}`);
        expect(ordinary).toContain("#3:");
        expect(ordinary).toContain(`[Replying to #${target.message_id}]`);
        expect(ordinary).not.toContain(`[Replying to: ${JSON.stringify(target.text)}]`);

        const selected = await turn(3, {
          reply_to_message: target,
          quote: { text: "Context fixture", position: 17 },
        });
        expect(selected).toContain('[Replying to: "Context fixture"]');
        expect(selected).toContain(`#${target.message_id}`);

        const external = await turn(4, {
          external_reply: {
            origin: { type: "user", sender_user: bot, date: target.date },
            chat: { id: -100999, type: "supergroup", title: "External fixture" },
            message_id: target.message_id,
            contact: { first_name: "Context fixture", phone_number: "+15550100001" },
          },
        });
        expect(external.split(target.text)).toHaveLength(3);
        expect(external).toContain(`[Replying to: ${JSON.stringify(target.text)}]`);
        expect(external).not.toContain(`[Replying to #${target.message_id}]`);
      } catch (error) {
        throw new Error(`${String(error)}\n${instance.logs()}`, { cause: error });
      }
    },
    () => instance.cleanup(),
    () => closeHttpServer(transport),
  );
}, 180000);
