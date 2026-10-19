import { crc32, deflateSync } from "node:zlib";
import type { Locator, Page } from "playwright";
import { assert, expect, it } from "vitest";
import type { StoredComposerState } from "../lib/chat/outbox-store.ts";
import {
  createChatFlowE2eSuite,
  expectRequestCountStable,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import {
  countOutboxPayloads,
  readOutboxQueue,
  readOutboxPayloadBytes,
} from "./chat-outbox-payloads.test-support.ts";

const suite = createChatFlowE2eSuite();
const largePngBytes = 2_404_765;
const smallPngBytes = 25_536;
const storageError =
  "Could not store this message for reconnect. Free browser storage or reconnect before sending.";

async function expectImages(images: Locator, count: number) {
  await expect.poll(() => images.count()).toBe(count);
  await expect
    .poll(() =>
      images.evaluateAll((items) =>
        items.every(
          (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
        ),
      ),
    )
    .toBe(true);
}

async function readImageBytes(images: Locator) {
  return images.evaluateAll((items) =>
    Promise.all(
      items.map(async (image) => {
        const bytes = new Uint8Array(
          await (await fetch((image as HTMLImageElement).src)).arrayBuffer(),
        );
        let binary = "";
        for (const byte of bytes) {
          binary += String.fromCharCode(byte);
        }
        return btoa(binary);
      }),
    ),
  );
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function sizedPng(size: number, color: number): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = pngChunk("IHDR", header);
  const idat = pngChunk("IDAT", deflateSync(Buffer.from([0, color, 100, 180, 255])));
  const iend = pngChunk("IEND", Buffer.alloc(0));
  // A CRC-covered tEXt ancillary chunk pads a decodable PNG, not trailing junk.
  const padding = Buffer.alloc(
    size - signature.length - ihdr.length - idat.length - iend.length - 12,
    120,
  );
  padding.write("Padding\0", 0, "ascii");
  return Buffer.concat([signature, ihdr, pngChunk("tEXt", padding), idat, iend]);
}

async function observeMockSends(page: Page) {
  return page.evaluateHandle(() => {
    const sends: Array<{
      message: string;
      queueMode?: string;
      sessionKey: string;
      runId: string;
      durableBeforeSend: boolean;
      storedSendState?: string;
      attachments: Array<{ fileName: string; mimeType: string; sizeBytes: number }>;
    }> = [];
    // oxlint-disable-next-line typescript/unbound-method -- Preserve the mock method for call(this, raw) and restore it on teardown.
    const send = WebSocket.prototype.send;
    // Observe the existing mock transport synchronously; storage and admission
    // remain native. Reading after chat.send alone cannot prove admission order.
    WebSocket.prototype.send = function (raw) {
      if (typeof raw === "string") {
        const frame = JSON.parse(raw) as {
          method?: string;
          params: {
            message: string;
            queueMode?: string;
            sessionKey: string;
            idempotencyKey: string;
            attachments?: Array<{ fileName: string; mimeType: string; content: string }>;
          };
        };
        if (frame.method === "chat.send") {
          const params = frame.params;
          const queue = Object.keys(sessionStorage)
            .filter((key) => key.startsWith("openclaw.control.chatComposer.v4:"))
            .flatMap((key) => {
              const stored = JSON.parse(sessionStorage.getItem(key)!) as StoredComposerState;
              return Object.values(stored.sessions).flatMap((session) => session.queue ?? []);
            });
          const persisted = queue.find((item) => item.sendRunId === params.idempotencyKey);
          const attachments = params.attachments ?? [];
          sends.push({
            message: params.message,
            queueMode: params.queueMode,
            sessionKey: params.sessionKey,
            runId: params.idempotencyKey,
            durableBeforeSend:
              persisted?.text === params.message &&
              persisted.queueMode === params.queueMode &&
              persisted.attachments?.length === attachments.length &&
              attachments.every((attachment, index) => {
                const stored = persisted.attachments?.[index];
                return (
                  stored?.fileName === attachment.fileName &&
                  stored.mimeType === attachment.mimeType &&
                  !stored.dataUrl &&
                  Boolean(persisted.attachmentPayload?.key)
                );
              }),
            storedSendState: persisted?.sendState,
            attachments: attachments.map((attachment) => ({
              fileName: attachment.fileName,
              mimeType: attachment.mimeType,
              sizeBytes: atob(attachment.content).length,
            })),
          });
        }
      }
      return send.call(this, raw);
    };
    return {
      sends,
      dispose: () => {
        WebSocket.prototype.send = send;
      },
    };
  });
}

suite.define(() => {
  it.each([
    { name: "one-large", sizes: [largePngBytes] },
    { name: "large-and-small", sizes: [largePngBytes, smallPngBytes] },
    { name: "two-large", sizes: [largePngBytes, largePngBytes] },
  ])(
    "durably admits $name PNG attachments before steering an active run (mock Gateway)",
    ({ name, sizes }) =>
      suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { width: 1280, height: 900 },
        },
        async ({ page }) => {
          const runId = "mock-active-capacity-run";
          const activeText = "Mock Gateway: the active run is still working.";
          const historyText = "Mock Gateway: inspect the attachment batch.";
          const gateway = await installMockGateway(page, {
            historyMessages: [{ role: "user", content: historyText }],
            inFlightRun: { runId, text: activeText },
            sessionInfo: { activeRunIds: [runId], hasActiveRun: true, key: "main" },
            deferredMethods: ["chat.send"],
          });
          await page.goto(`${suite.server.baseUrl}settings/appearance`);
          await page.locator("[data-settings-follow-up-mode]").selectOption("steer");
          await gateway.waitForRequest("config.patch");
          await page.goto(`${suite.server.baseUrl}chat`);
          const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
          const composer = pane.locator(".agent-chat__composer-combobox textarea");
          const stop = pane.getByRole("button", { name: "Stop generating" });
          const steer = pane.getByRole("button", {
            name: "Steer into the active run",
            exact: true,
          });
          const history = pane.getByText(historyText, { exact: true });
          const active = pane.getByText(activeText, { exact: true });
          await history.waitFor();
          await active.waitFor();
          await stop.waitFor();
          const files = sizes.map((size, index) => ({
            name: `mock-${name}-${index + 1}.png`,
            mimeType: "image/png",
            buffer: sizedPng(size, 60 + index * 100),
          }));
          expect(files.map((file) => file.buffer.length)).toEqual(sizes);
          const message = `Mock Gateway: steer with ${name} PNG batch.`;
          await composer.fill(message);
          await pane.locator(".agent-chat__file-input").setInputFiles(files);
          const previews = pane.locator(".chat-attachment-thumb img");
          await expectImages(previews, files.length);
          const acceptedBytes = await previews.evaluateAll(async (images) =>
            Promise.all(
              images.map(
                async (image) => (await (await fetch((image as HTMLImageElement).src)).blob()).size,
              ),
            ),
          );
          expect(acceptedBytes).toEqual(sizes);
          await expect.poll(() => steer.isEnabled()).toBe(true);
          expect(await pane.locator(".chat-queue__item").count()).toBe(0);
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          const observation = await observeMockSends(page);
          try {
            await steer.click();
            const outcomeHandle = await page.waitForFunction(
              ({ proof, error }) => {
                const errorVisible = [...document.querySelectorAll('[role="alert"]')].some(
                  (alert) => alert.textContent?.includes(error),
                );
                return proof.sends.length > 0 ? "sent" : errorVisible ? "storage-rejected" : false;
              },
              { proof: observation, error: storageError },
            );
            const outcome = await outcomeHandle.jsonValue();
            await outcomeHandle.dispose();
            const sends = await observation.evaluate((proof) => proof.sends);
            const requests = await gateway.getRequests("chat.send");
            const evidence = {
              outcome,
              sends,
              draft: await composer.inputValue(),
              attachmentPreviews: await previews.count(),
              queueRows: await pane.locator(".chat-queue__item").count(),
            };
            // Failed admission must retain the entire draft, with no phantom queue
            // entry or send. The success contract below still fails on that outcome.
            if (outcome === "storage-rejected") {
              expect(evidence).toMatchObject({
                draft: message,
                attachmentPreviews: files.length,
                queueRows: 0,
              });
              await expectRequestCountStable(gateway, "chat.send", 0);
            }
            const captureImages = pane.locator(".chat-attachment-thumb img, .chat-message-image");
            await expectImages(captureImages, files.length);
            await history.waitFor();
            await active.waitFor();

            expect(outcome, JSON.stringify(evidence)).toBe("sent");
            const payload = (await readOutboxQueue(page))[0]?.attachmentPayload;
            assert(payload, "Expected admitted payload reference");
            expect(await countOutboxPayloads(page)).toBe(1);
            const payloads = await readOutboxPayloadBytes(page, payload.key);
            expect(payloads).toEqual(files.map((file) => file.buffer.toString("base64")));
            expect(requests[0]?.params).toHaveProperty(
              "attachments",
              files.map((file) => ({
                type: "image",
                origin: "file",
                mimeType: file.mimeType,
                fileName: file.name,
                content: file.buffer.toString("base64"),
              })),
            );
            expect(sends).toEqual([
              {
                message,
                queueMode: "steer",
                sessionKey: "agent:main:main",
                runId: expect.any(String),
                durableBeforeSend: true,
                storedSendState: "waiting-reconnect",
                attachments: files.map((file) => ({
                  fileName: file.name,
                  mimeType: file.mimeType,
                  sizeBytes: file.buffer.length,
                })),
              },
            ]);
            await expect.poll(() => composer.inputValue()).toBe("");
            await expect.poll(() => previews.count()).toBe(0);
            await pane.locator(".chat-group.user", { hasText: message }).waitFor();
            expect(await pane.locator(".chat-queue__item").count()).toBe(0);
            await stop.waitFor();
            await expectRequestCountStable(gateway, "chat.send", 1);
            const sent = sends[0];
            assert(sent, "Expected the observed chat.send before emitting its terminal");
            await gateway.resolveDeferred("chat.send");
            await stop.waitFor();
            await gateway.deferNext("chat.history");
            await gateway.emitChatFinal({
              runId: sent.runId,
              text: "Mock Gateway: attachment delivery finished before history persisted.",
            });
            await expect
              .poll(
                async () =>
                  (await readOutboxQueue(page)).filter((item) => item.sendRunId === sent.runId)
                    .length,
              )
              .toBe(0);
            const deliveredImages = pane
              .locator(".chat-group.user", { hasText: message })
              .locator(".chat-message-image");
            await expectImages(deliveredImages, files.length);
            const deliveredBytes = await readImageBytes(deliveredImages);
            expect(deliveredBytes).toEqual(files.map((file) => file.buffer.toString("base64")));
            await expect.poll(() => countOutboxPayloads(page)).toBe(0);
            await expectRequestCountStable(gateway, "chat.send", 1);
          } finally {
            await observation.evaluate((proof) => proof.dispose());
            await observation.dispose();
          }
        },
      ),
  );
});
