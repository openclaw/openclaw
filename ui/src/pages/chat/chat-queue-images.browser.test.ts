import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { t } from "../../i18n/index.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  getChatAttachmentPreviewUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { renderChatQueue } from "./components/chat-composer-queue.tsx";
import baseStyles from "../../styles/base.css?inline";
import queueStyles from "../../styles/chat/composer-queue.css?inline";

const imageData =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

describe("queued image snippets", () => {
  let container: HTMLDivElement;
  let styles: HTMLStyleElement;
  let attachments: ChatAttachment[];

  beforeEach(() => {
    styles = document.createElement("style");
    styles.textContent = baseStyles + queueStyles;
    document.head.append(styles);
    container = document.createElement("div");
    container.className = "agent-chat__composer-shell";
    container.style.width = "calc(100vw - 32px)";
    document.body.append(container);
    attachments = Array.from({ length: 12 }, (_, index) => ({
      id: "queue-image-" + index,
      mimeType: "image/png",
      dataUrl: imageData,
    }));
  });

  afterEach(() => {
    render(nothing, container);
    container.remove();
    styles.remove();
    releaseChatAttachmentPayloads(attachments);
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.removeAttribute("data-theme-mode");
  });

  function draw(queue: ChatQueueItem[], editingId?: string) {
    render(
      renderChatQueue({
        queue,
        queuedEdit: { editingId: editingId ?? null, onCancel: vi.fn(), onEdit: vi.fn() },
        onQueueRemove: vi.fn(),
      }),
      container,
    );
  }

  it.each([
    [960, "dark", undefined, true],
    [390, "light", "failed", true],
    [390, "dark", "waiting-reconnect", false],
    [960, "light", "waiting-idle", false],
  ] as const)(
    "keeps images aligned at %ipx in %s with state %s",
    async (width, theme, state, withAvatar) => {
      await page.viewport(width, 800);
      document.documentElement.dataset.theme = "claw";
      document.documentElement.dataset.themeMode = theme;
      const queue = [0, 1, 2, 12].map((count): ChatQueueItem => ({
        id: "count-" + count,
        text: "Reference",
        createdAt: count,
        sender: withAvatar ? { name: "Alex" } : undefined,
        sendState: state,
        sendError: state === "failed" ? "Upload failed" : undefined,
        queueMode: state === "waiting-idle" ? "steer" : undefined,
        attachments: attachments.slice(0, count),
      }));
      draw(queue.map((item) => ({ ...item, attachments: [] })));
      const baselineHeights = [...container.querySelectorAll(".chat-queue__item")].map(
        (row) => row.getBoundingClientRect().height,
      );
      draw(queue);
      const rows = [...container.querySelectorAll<HTMLElement>(".chat-queue__item")];
      const snippets = [...container.querySelectorAll<HTMLImageElement>(".chat-queue__images")];
      expect(snippets).toHaveLength(3);
      // Compare like-for-like: the last row intentionally has no bottom divider.
      for (const [index, row] of rows.entries()) {
        expect(row.getBoundingClientRect().height).toBe(baselineHeights[index]);
      }
      const textStarts = rows
        .slice(1)
        .map((row) => row.querySelector(".chat-queue__text")!.getBoundingClientRect().left);
      expect(new Set(textStarts).size).toBe(1);
      for (const row of rows.slice(1)) {
        expect(row.querySelectorAll("img.chat-queue__images")).toHaveLength(1);
        const error = row.querySelector(".chat-queue__error");
        if (error) {
          expect(error.getBoundingClientRect().left).toBe(textStarts[0]);
        }
      }
      for (const image of snippets) {
        const box = image.getBoundingClientRect();
        expect(box.width).toBe(24);
        expect(box.height).toBe(24);
        expect(image.draggable).toBe(false);
        expect(image.hasAttribute("title")).toBe(false);
        expect(image.tabIndex).toBe(-1);
        const promptGap = textStarts[0]! - box.right;
        expect(promptGap).toBeGreaterThanOrEqual(4);
        expect(promptGap).toBeLessThanOrEqual(8);
      }
      draw(queue, "count-12");
      expect(container.querySelectorAll(".chat-queue__images")).toHaveLength(3);
      const edited = container.querySelector(".chat-queue__item--editing")!;
      expect(edited.querySelector(".chat-queue__edit-input")!.getBoundingClientRect().left).toBe(
        textStarts[0],
      );
    },
  );

  it("uses retained payloads, ignores non-images, and preserves image-only copy", () => {
    const payloadOnly: ChatAttachment = { id: "payload-only", mimeType: "image/png" };
    registerChatAttachmentPayload({
      attachment: payloadOnly,
      dataUrl: imageData,
      file: new File(["fixture"], "image.png", { type: "image/png" }),
    });
    attachments.push(payloadOnly);
    const file: ChatAttachment = {
      id: "document",
      mimeType: "application/pdf",
      fileName: "notes.pdf",
    };
    draw([
      { id: "file", text: "Read this", createdAt: 1, attachments: [file] },
      {
        id: "mixed",
        text: "Compare",
        createdAt: 2,
        attachments: [file, payloadOnly, attachments[0]!],
      },
      { id: "image-only", text: "", createdAt: 3, attachments: [attachments[1]!] },
      {
        id: "missing",
        text: "Unavailable payload",
        createdAt: 4,
        attachments: [{ id: "missing-image", mimeType: "image/png" }],
      },
    ]);
    const rows = [...container.querySelectorAll(".chat-queue__item")];
    expect(rows[0]!.querySelector(".chat-queue__images")).toBeNull();
    const preview = rows[1]!.querySelector(".chat-queue__images")!;
    expect(preview.getAttribute("src")).toBe(getChatAttachmentPreviewUrl(payloadOnly));
    expect(preview.getAttribute("alt")).toBe(t("chat.queue.imageCount", { count: "2" }));
    expect(rows[2]!.querySelector(".chat-queue__text")!.textContent).toBe(
      t("chat.queue.imageCount", { count: "1" }),
    );
    expect(rows[3]!.querySelector(".chat-queue__images")).toBeNull();
  });
});
