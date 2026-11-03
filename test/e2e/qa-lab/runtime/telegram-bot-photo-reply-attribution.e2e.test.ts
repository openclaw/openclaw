import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { buffer as readRequest } from "node:stream/consumers";
import { withServer, withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, test } from "vitest";
import {
  type MockOpenAiRequestSnapshot,
  TINY_PNG_BASE64,
  createQaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import {
  bindTelegramProof,
  createTelegramApi,
  settleTelegramCleanup,
  succeedTelegram,
  telegramGatewayOptions,
  telegramProofChannel,
  telegramRequestHandler,
} from "./telegram-gateway.test-support.js";

type JsonObject = Record<string, unknown>;
const BOT = { id: 424242, is_bot: true, first_name: "QA Photo", username: "qa_photo_bot" };
const BOT_TOKEN = `${BOT.id}:${"A".repeat(35)}`;
const USER = { id: 777, is_bot: false, first_name: "Ada" };
const CHAT = { id: USER.id, type: "private", first_name: USER.first_name };
const SELF_SENDER = `${BOT.first_name} (you)`;
// A red 1x1 PNG, distinct from the bot's photo.
const USER_PHOTO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

// Images in the turn's user input, and which media URIs the text ties to the bot itself.
function describeTurn(request: MockOpenAiRequestSnapshot) {
  const input = (request.body.input ?? []) as JsonObject[];
  const parts = input
    .slice(input.findLastIndex((item) => item.role === "assistant") + 1)
    .filter((item) => item.role === "user")
    .flatMap((item) =>
      Array.isArray(item.content)
        ? (item.content as JsonObject[])
        : [{ type: "input_text", text: item.content }],
    );
  // Runtime context arrives as a JSON string, so its line breaks are escaped.
  const lines = parts
    .filter((part) => part.type === "input_text")
    .flatMap((part) => String(part.text).split(/\n|\\n/u));
  const mediaUris = (line: string) => line.match(/media:\/\/inbound\/[^\s\]"\\]+/gu) ?? [];
  return {
    images: parts.filter((part) => part.type === "input_image").length,
    attached: lines.filter((line) => line.startsWith("[media attached")).flatMap(mediaUris),
    selfAuthored: lines.filter((line) => line.includes(`${SELF_SENDER}:`)).flatMap(mediaUris),
  };
}

test("keeps a replied bot photo inspectable and attributed to the bot in the provider request", async () => {
  const marker = randomUUID().slice(0, 8);
  const replyOnlyMarker = `QA-BOT-PHOTO-REPLY-ONLY-${marker}`;
  const newPhotoMarker = `QA-BOT-PHOTO-NEW-PHOTO-${marker}`;
  const files = new Map([["photos/user.png", USER_PHOTO]]);
  let botPhotoMessage: JsonObject | undefined;
  let sends = 0;
  const api = createTelegramApi({
    token: BOT_TOKEN,
    bot: BOT,
    chat: CHAT,
    messageId: () => 9000 + ++sends,
    now: () => Math.floor(Date.now() / 1000),
  });
  let updateId = 0;
  const sendInbound = (message: JsonObject) =>
    api.updates.enqueue({
      update_id: ++updateId,
      message: {
        message_id: 100 + updateId,
        date: Math.floor(Date.now() / 1000),
        chat: CHAT,
        from: USER,
        ...message,
      },
    });
  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const file = files.get(pathname.replace(`/file/bot${BOT_TOKEN}/`, ""));
    if (file) {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(file);
      return;
    }
    if (pathname.endsWith("/sendPhoto")) {
      // grammY uploads local media as multipart and references the part from `photo`.
      const form = await new Response(new Uint8Array(await readRequest(req)), {
        headers: { "content-type": String(req.headers["content-type"]) },
      }).formData();
      const reference = form.get("photo");
      const upload =
        typeof reference === "string" ? form.get(reference.replace("attach://", "")) : null;
      if (!(upload instanceof File)) {
        throw new Error("Telegram photo did not reference a multipart upload");
      }
      files.set("photos/bot.png", Buffer.from(await upload.arrayBuffer()));
      const caption = form.get("caption");
      botPhotoMessage = {
        message_id: 9000 + ++sends,
        date: Math.floor(Date.now() / 1000),
        chat: CHAT,
        from: BOT,
        ...(typeof caption === "string" ? { caption } : {}),
        photo: [{ file_id: "bot-photo", file_unique_id: "bot-photo-u", width: 1, height: 1 }],
      };
      succeedTelegram(res, botPhotoMessage);
      return;
    }
    if (pathname.endsWith("/getFile")) {
      const { file_id: fileId } = JSON.parse((await readRequest(req)).toString()) as JsonObject;
      const filePath = fileId === "bot-photo" ? "photos/bot.png" : "photos/user.png";
      succeedTelegram(res, {
        file_id: fileId,
        file_unique_id: `${String(fileId)}-u`,
        file_path: filePath,
      });
      return;
    }
    await api.handle(req, res);
  };

  await withServer(telegramRequestHandler(handleRequest), async (apiRoot) =>
    withTempDir("openclaw-telegram-bot-photo-", async (workspace) => {
      await writeFile(
        path.join(workspace, "bot-photo.png"),
        Buffer.from(TINY_PNG_BASE64, "base64"),
      );
      const mock = await startQaMockOpenAiServer();
      const owner = createQaGatewayChild();
      try {
        await owner.start(
          telegramGatewayOptions({
            workspace,
            apiRoot,
            providerMode: "mock-openai",
            providerBaseUrl: `${mock.baseUrl}/v1`,
            telegram: telegramProofChannel(apiRoot, BOT_TOKEN, {
              dmPolicy: "open",
              allowFrom: ["*"],
              commands: { native: false },
              streaming: { mode: "off" },
            }),
            runtimeEnvPatch: {
              OPENCLAW_SKIP_CHANNELS: undefined,
              OPENCLAW_SKIP_PROVIDERS: undefined,
            },
            mutateConfig: bindTelegramProof,
          }),
        );
        await expect
          .poll(() => api.updates.pendingPolls.size, { timeout: 30_000 })
          .toBeGreaterThan(0);
        const delivered = (text: string) =>
          api.calls.some((call) => call.method === "sendMessage" && call.body.text === text);

        // The bot sends a photo through its real outbound path.
        sendInbound({
          text: "Send me your photo. Reply exactly `Here is my photo\nMEDIA:./bot-photo.png`",
        });
        await expect.poll(() => botPhotoMessage, { timeout: 60_000 }).toBeDefined();
        // The user replies to it with a question and no attachment.
        sendInbound({
          text: `What is in this picture? Reply exactly \`${replyOnlyMarker}\``,
          reply_to_message: botPhotoMessage,
        });
        await expect.poll(() => delivered(replyOnlyMarker), { timeout: 60_000 }).toBe(true);
        // Control: the user replies to the same photo with a distinct new photo.
        sendInbound({
          caption: `Is my photo the same as yours? Reply exactly \`${newPhotoMarker}\``,
          photo: [{ file_id: "user-photo", file_unique_id: "user-photo-u", width: 1, height: 1 }],
          reply_to_message: botPhotoMessage,
        });
        await expect.poll(() => delivered(newPhotoMarker), { timeout: 60_000 }).toBe(true);

        const requests = (await (
          await fetch(`${mock.baseUrl}/debug/requests`)
        ).json()) as MockOpenAiRequestSnapshot[];
        // A turn's first request carries its inbound message; later turns replay its marker.
        const turn = (needle: string) =>
          describeTurn(requests.find((request) => request.allInputText.includes(needle))!);
        const replyOnly = turn(replyOnlyMarker);
        expect(replyOnly.images).toBe(1);
        expect(replyOnly.attached).toHaveLength(1);
        expect(replyOnly.selfAuthored).toContain(replyOnly.attached[0]);

        const newPhoto = turn(newPhotoMarker);
        const [currentPhoto, quotedPhoto] = newPhoto.attached;
        expect(newPhoto.images).toBe(2);
        expect(newPhoto.attached).toHaveLength(2);
        expect(currentPhoto).not.toBe(quotedPhoto);
        expect(newPhoto.selfAuthored).toContain(quotedPhoto);
        expect(newPhoto.selfAuthored).not.toContain(currentPhoto);
      } finally {
        await settleTelegramCleanup(
          () => stopQaGatewayFixture(owner),
          () => mock.stop(),
        );
        for (const poll of api.updates.pendingPolls) {
          poll.destroy();
        }
      }
    }),
  );
}, 180_000);
