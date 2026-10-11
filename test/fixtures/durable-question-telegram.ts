import { createServer, type ServerResponse } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createDeferredCore } from "../../src/shared/deferred.js";
import { reserveTestPortListener } from "../../src/test-utils/port-claims.js";

/** Local Bot API transport; the bundled Telegram plugin owns ingress and authority. */
export async function createDurableQuestionTelegram(signal: AbortSignal) {
  const token = "123456:synthetic_durable_question_proof";
  const senderId = "42001";
  const chat = { id: Number(senderId), type: "private", first_name: "Proof" };
  const ready = createDeferredCore();
  const deliveries: string[] = [];
  const recipients: string[] = [];
  const pending = new Set<ServerResponse>();
  const updates: unknown[] = [];
  let messageId = 100;
  const respond = (response: ServerResponse, result: unknown) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result }));
  };
  const flush = () => {
    const response = pending.values().next().value;
    if (response && updates.length) {
      pending.delete(response);
      respond(response, updates.splice(0));
    }
  };
  const listener = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      createServer((request, response) => {
        void (async () => {
          const url = new URL(request.url ?? "/", "http://localhost");
          if (!url.pathname.startsWith(`/bot${token}/`)) {
            response.writeHead(403).end();
            return;
          }
          const method = url.pathname.split("/").at(-1);
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.from(chunk));
          }
          const body = Buffer.concat(chunks).toString("utf8");
          const value: unknown = body
            ? request.headers["content-type"]?.includes("application/json")
              ? JSON.parse(body)
              : Object.fromEntries(new URLSearchParams(body))
            : Object.fromEntries(url.searchParams);
          if (!isRecord(value)) {
            throw new Error("Invalid synthetic Bot API request");
          }
          if (method === "getUpdates") {
            pending.add(response);
            response.once("close", () => pending.delete(response));
            ready.resolve();
            flush();
            return;
          }
          if (method === "getMe") {
            respond(response, {
              id: 123456,
              is_bot: true,
              first_name: "Durable proof",
              username: "durable_question_proof_bot",
              can_join_groups: true,
              can_read_all_group_messages: false,
              supports_inline_queries: false,
            });
          } else if (method === "getWebhookInfo") {
            respond(response, { url: "", has_custom_certificate: false, pending_update_count: 0 });
          } else if (method === "getChat") {
            respond(response, chat);
          } else if (method === "sendMessage" || method === "editMessageText") {
            if (typeof value.text !== "string") {
              throw new Error("Synthetic Bot API text missing");
            }
            deliveries.push(value.text);
            recipients.push(String(value.chat_id));
            respond(response, {
              message_id: ++messageId,
              date: Math.floor(Date.now() / 1000),
              chat,
              text: value.text,
            });
          } else if (
            [
              "deleteWebhook",
              "setMyCommands",
              "deleteMyCommands",
              "sendChatAction",
              "editMessageReplyMarkup",
            ].includes(method ?? "")
          ) {
            respond(response, true);
          } else {
            throw new Error(`Unexpected synthetic Bot API method: ${String(method)}`);
          }
        })().catch((error: unknown) => {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, description: String(error), error_code: 500 }));
        });
      }),
  });
  return {
    token,
    senderId,
    apiRoot: `http://127.0.0.1:${listener.claim.port}`,
    ready: ready.promise,
    deliveries,
    recipients,
    send: (text: string) => {
      updates.push({
        update_id: 1,
        message: {
          message_id: 1,
          date: Math.floor(Date.now() / 1000),
          chat,
          from: { id: Number(senderId), is_bot: false, first_name: "Proof" },
          text,
        },
      });
      flush();
    },
    close: async () => {
      listener.listener.closeAllConnections();
      await listener.releaseListener();
      listener.claim.release();
    },
  };
}
