import { crc32 } from "node:zlib";
import type { BrowserContext, Locator, Page } from "playwright";
import { expect } from "vitest";
import { encodePngRgba } from "../../../src/media/png-encode.ts";
import type { ChatQueueItem } from "../lib/chat/chat-types.ts";
import { readOutboxPayloadAttachments } from "./chat-flow.test-support.ts";
function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

export function sizedOutboxPng(size: number, color = 255): Buffer {
  const png = encodePngRgba(Buffer.from([color, 100, 180, 255]), 1, 1);
  // A CRC-covered tEXt ancillary chunk pads a decodable PNG, not trailing junk.
  const padding = Buffer.alloc(size - png.length - 12, 120);
  padding.write("Padding\0", 0, "ascii");
  return Buffer.concat([png.subarray(0, -12), pngChunk("tEXt", padding), png.subarray(-12)]);
}

export const outboxPayloadFile = {
  name: "mock-original.txt",
  mimeType: "text/plain",
  buffer: Buffer.from("Exact synthetic outbox bytes\n".repeat(1000)),
};
export const outboxPayloadHistory = [
  { role: "assistant", content: "Mock Gateway: payload lifecycle proof." },
];
export const outboxPageOptions = {
  serviceWorkers: "block" as const,
  viewport: { width: 1280, height: 900 },
};
export const outboxButton = (target: Page | Locator, name: string) =>
  target.getByRole("button", { name, exact: true });
export const outboxPaneFor = (page: Page) =>
  page.locator('openclaw-chat-pane[aria-hidden="false"]');
export const outboxComposerFor = (page: Page) =>
  outboxPaneFor(page).locator(".agent-chat__composer-combobox textarea");
export const sendOutboxMessage = (page: Page) =>
  outboxButton(outboxPaneFor(page), "Send message").click();
export const outboxAttachment = {
  type: "file",
  mimeType: outboxPayloadFile.mimeType,
  fileName: outboxPayloadFile.name,
  origin: "file",
  content: outboxPayloadFile.buffer.toString("base64"),
};
export const expectOutboxPayload = async (page: Page, key: string) =>
  expect(await readOutboxPayloadBytes(page, key)).toEqual([outboxAttachment.content]);

export async function readOutboxQueue(page: Page): Promise<ChatQueueItem[]> {
  return page.evaluate(() =>
    Object.keys(sessionStorage)
      .filter((key) => key.startsWith("openclaw.control.chatComposer.v4:"))
      .flatMap((key) => {
        const store = JSON.parse(sessionStorage.getItem(key)!) as {
          sessions: Record<string, { queue?: ChatQueueItem[] }>;
        };
        return Object.values(store.sessions).flatMap((session) => session.queue ?? []);
      }),
  );
}

export async function countOutboxPayloads(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("openclaw-control-ui");
      request.onsuccess = () => resolve(request.result);
      request.addEventListener("error", () =>
        reject(request.error ?? new Error("IndexedDB request failed")),
      );
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        const request = database
          .transaction("outboxPayloads")
          .objectStore("outboxPayloads")
          .count();
        request.onsuccess = () => resolve(request.result);
        request.addEventListener("error", () =>
          reject(request.error ?? new Error("IndexedDB request failed")),
        );
      });
    } finally {
      database.close();
    }
  });
}

export async function readOutboxPayloadBytes(page: Page, key: string): Promise<string[] | null> {
  return (
    (await readOutboxPayloadAttachments(page, key))?.map((attachment) => attachment.base64) ?? null
  );
}

export async function stageOutboxAttachment(page: Page, message: string) {
  await outboxComposerFor(page).fill(message);
  await outboxPaneFor(page).locator(".agent-chat__file-input").setInputFiles(outboxPayloadFile);
  await expect.poll(() => outboxPaneFor(page).locator(".chat-attachment-thumb").count()).toBe(1);
}

export async function outboxChatUrl(
  context: BrowserContext,
  baseUrl: string,
  origin: "localhost" | "plain HTTP",
) {
  const url = new URL("chat", baseUrl);
  if (origin === "plain HTTP") {
    url.hostname = "plain-http.test";
    await context.route(`${url.origin}/**`, async (route) => {
      const target = new URL(route.request().url());
      target.hostname = "127.0.0.1";
      await route.continue({ url: target.href });
    });
  }
  return url.href;
}

/** Pause native Blob decoding in the next document until reconnect has parked the source. */
export async function holdOutboxPreviewReads(page: Page): Promise<() => Promise<number>> {
  await page.addInitScript(() => {
    const NativeFileReader = FileReader;
    const pending: Array<() => void> = [];
    let released = false;
    globalThis.FileReader = class extends NativeFileReader {
      override readAsDataURL(blob: Blob): void {
        if (released) {
          super.readAsDataURL(blob);
        } else {
          pending.push(() => super.readAsDataURL(blob));
        }
      }
    };
    Object.assign(window, {
      releaseOutboxPreviewRead() {
        released = true;
        const reads = pending.splice(0);
        reads.forEach((resume) => resume());
        return reads.length;
      },
    });
  });
  return () =>
    page.evaluate(() =>
      (window as unknown as { releaseOutboxPreviewRead(): number }).releaseOutboxPreviewRead(),
    );
}
