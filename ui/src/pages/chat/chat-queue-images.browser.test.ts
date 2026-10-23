import { createComponent, merge } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { t } from "../../i18n/index.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  getChatAttachmentPreviewUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { renderChatQueueSolid } from "./components/chat-composer-queue.tsx";
import { createSolidRenderLifecycle } from "./solid-render-lifecycle.ts";
import baseStyles from "../../styles/base.css?inline";
import queueStyles from "../../styles/chat/composer-queue.css?inline";
import componentStyles from "../../styles/components.css?inline";

const imageData =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

let container: HTMLDivElement;
let styles: HTMLStyleElement;
let attachments: ChatAttachment[];
let view: ReturnType<typeof mountSolid> | undefined;
type QueueProps = Parameters<typeof renderChatQueueSolid>[0];
let current: QueueProps;
let invalidate: (() => void) | undefined;
const all = <T extends HTMLElement = HTMLElement>(selector: string) => [
  ...container.querySelectorAll<T>(selector),
];
const left = (row: Element, selector: string) =>
  row.querySelector(selector)!.getBoundingClientRect().left;

beforeEach(() => {
  styles = document.createElement("style");
  styles.textContent = baseStyles + componentStyles + queueStyles;
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
  view?.unmount();
  view = undefined;
  invalidate = undefined;
  container.remove();
  styles.remove();
  releaseChatAttachmentPayloads(attachments);
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-mode");
});

function draw(queue: ChatQueueItem[], editingId?: string, onQueueMove?: QueueProps["onQueueMove"]) {
  current = {
    queue,
    onQueueMove,
    queuedEdit: onQueueMove
      ? undefined
      : { editingId: editingId ?? null, onCancel: vi.fn(), onEdit: vi.fn() },
    onQueueRemove: vi.fn(),
  };
  if (invalidate) {
    invalidate();
  } else {
    view = mountSolid(
      () => {
        const lifecycle = createSolidRenderLifecycle({
          host: {},
          presented: () => true,
          read: () => current,
        });
        invalidate = () => lifecycle.invalidate();
        return createComponent(renderChatQueueSolid, merge(lifecycle.snapshot));
      },
      { container },
    );
  }
  flush();
}

it.each([
  { key: "ArrowUp", expected: ["c", "b"] },
  { key: "ArrowDown", expected: ["c", "d"] },
])("moves the focused row on $key", async ({ key, expected }) => {
  const waiting = (id: string, createdAt: number): ChatQueueItem => ({
    id,
    text: id,
    createdAt,
    sendState: "waiting-reconnect",
  });
  let queue = ["a", "b", "c", "d"].map((id, index) => waiting(id, index + 1));
  const ids = key === "ArrowUp" ? ["a", "c", "b", "d"] : ["a", "b", "d", "c"];
  const onQueueMove = vi.fn<(id: string, targetId: string) => void>(() => {
    queue = ids.map((id, index) => waiting(id, index));
    current = { ...current, queue };
    invalidate?.();
  });
  draw(queue, undefined, onQueueMove);
  await waitForSolid(() => expect(all(".chat-queue__grip")).toHaveLength(4));
  const grip = all<HTMLButtonElement>(".chat-queue__grip")[2]!;
  grip.focus();
  expect(document.activeElement).toBe(grip);

  let moveEvent: KeyboardEvent | undefined;
  container.addEventListener(
    "keydown",
    (event) => {
      moveEvent = event;
    },
    { once: true },
  );
  await userEvent.keyboard(`{${key}}`);
  expect(onQueueMove.mock.calls).toEqual([expected]);
  // Arrow keys belong to the handle, so the transcript must not also scroll.
  expect(moveEvent?.defaultPrevented).toBe(true);
  await waitForSolid(() =>
    expect(all("[data-chat-queue-item]").map((row) => row.dataset.chatQueueItem)).toEqual(ids),
  );
  expect(container.querySelector('[data-chat-queue-item="c"] .chat-queue__grip')).toBe(grip);
  expect(document.activeElement).toBe(grip);
  await userEvent.keyboard(`{${key}}`);
  if (key === "ArrowUp") {
    expect(onQueueMove).toHaveBeenLastCalledWith("c", "a");
  } else {
    expect(onQueueMove).toHaveBeenCalledOnce();
  }
});

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
    const baselineHeights = all(".chat-queue__item").map(
      (row) => row.getBoundingClientRect().height,
    );
    draw(queue);
    const rows = all(".chat-queue__item");
    const snippets = all<HTMLImageElement>(".chat-queue__images");
    expect(snippets).toHaveLength(3);
    // Compare like-for-like: the last row intentionally has no bottom divider.
    for (const [index, row] of rows.entries()) {
      expect(row.getBoundingClientRect().height).toBe(baselineHeights[index]);
    }
    const textStarts = rows.slice(1).map((row) => left(row, ".chat-queue__text"));
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
      expect(box).toMatchObject({ width: 24, height: 24 });
      expect(image).toMatchObject({ draggable: false, tabIndex: -1 });
      expect(image.hasAttribute("title")).toBe(false);
      const promptGap = textStarts[0]! - box.right;
      expect(promptGap).toBeGreaterThanOrEqual(4);
      expect(promptGap).toBeLessThanOrEqual(8);
    }
    draw(queue, "count-12");
    expect(all(".chat-queue__images")).toHaveLength(3);
    const edited = container.querySelector(".chat-queue__item--editing")!;
    expect(left(edited, ".chat-queue__edit-input")).toBe(textStarts[0]);
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
  const examples: Array<[string, string, ChatAttachment[]]> = [
    ["file", "Read this", [file]],
    ["mixed", "Compare", [file, payloadOnly, attachments[0]!]],
    ["image-only", "", [attachments[1]!]],
    ["missing", "Unavailable payload", [{ id: "missing-image", mimeType: "image/png" }]],
  ];
  draw(
    examples.map(([id, text, images], index) => ({
      id,
      text,
      attachments: images,
      createdAt: index + 1,
    })),
  );
  const rows = all(".chat-queue__item");
  expect(rows[0]!.querySelector(".chat-queue__images")).toBeNull();
  const preview = rows[1]!.querySelector(".chat-queue__images")!;
  expect(preview.getAttribute("src")).toBe(getChatAttachmentPreviewUrl(payloadOnly));
  expect(preview.getAttribute("alt")).toBe(t("chat.queue.imageCount", { count: "2" }));
  expect(rows[2]!.querySelector(".chat-queue__text")!.textContent).toBe(
    t("chat.queue.imageCount", { count: "1" }),
  );
  expect(rows[3]!.querySelector(".chat-queue__images")).toBeNull();
});
