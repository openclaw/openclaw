/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { resetChatViewState } from "./chat-view-state.test-support.ts";
import { renderChatView, requireElement } from "./chat-view.test-helpers.ts";
import { installChatComposerPickerDismissal } from "./components/chat-picker-overlay.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

beforeEach(() => {
  onTestFinished(installChatComposerPickerDismissal(document));
  installTranscriptDomMocks();
});

afterEach(() => {
  resetChatViewState();
  resetTranscriptTestDom();
});

const cardClass = ".chat-attachment-thumb--browser-annotation";
const identityClass = ".chat-browser-annotation-card__identity";
const longTitle = "Checkout page with a deliberately long title";
function annotation(
  title: string,
  displayUrl: string,
  markedRegionCount = 0,
  inspectedElement = false,
) {
  return {
    modelContext: "Context for the model",
    title,
    displayUrl,
    markedRegionCount,
    inspectedElement,
  };
}

describe("chat attachment previews", () => {
  it("renders multiple browser annotations as bounded, accessible cards", async () => {
    const annotations: ChatAttachment[] = (
      [
        ["annotation-title", longTitle, "shop.example.test/checkout", 2, true],
        ["annotation-url", "", "docs.example.test/narrow-layout", 1, false],
      ] as const
    ).map(([id, title, url, count, inspected]) => ({
      id,
      mimeType: "image/png",
      previewUrl: `blob:${id}`,
      browserAnnotation: annotation(title, url, count, inspected),
    }));

    const container = renderChatView({ attachments: annotations });
    await waitForSolid(() => expect(container.querySelectorAll(cardClass)).toHaveLength(2));
    const cards = container.querySelectorAll<HTMLElement>(cardClass);

    expect(cards[0]?.dataset.attachmentId).toBe("annotation-title");
    expect(cards[0]?.getAttribute("role")).toBe("group");
    expect(cards[0]?.getAttribute("aria-label")).toBe(`Browser annotation: ${longTitle}`);
    expect(cards[0]?.querySelector("img")?.getAttribute("alt")).toBe("Browser annotation preview");
    expect(cards[0]?.querySelector(identityClass)?.textContent).toBe(longTitle);
    expect(cards[0]?.querySelector(".chat-browser-annotation-card__meta")?.textContent).toContain(
      "2 marked regions",
    );
    expect(cards[1]?.querySelector(identityClass)?.textContent).toBe(
      "docs.example.test/narrow-layout",
    );
    expect(cards[1]?.textContent).toContain("1 marked region");
    expect(
      cards[0]?.querySelector(`[aria-label="Remove browser annotation: ${longTitle}"]`),
    ).toBeInstanceOf(HTMLButtonElement);
    for (const card of cards) {
      expect(card.textContent).not.toContain("Element inspected");
      expect(card.querySelector(".chat-browser-annotation-card__preview")).not.toBeNull();
      expect(card.querySelector(".chat-browser-annotation-card__body")).not.toBeNull();
    }
  });

  it.each([true, false])(
    "routes attachment removal to its owner (annotation=%s)",
    async (isAnnotation) => {
      const name = isAnnotation ? "annotation" : "ordinary";
      const attachment = registerChatAttachmentPayload({
        attachment: {
          id: `${name}-remove`,
          fileName: `${name}.png`,
          mimeType: "image/png",
          ...(isAnnotation
            ? { browserAnnotation: annotation("Account settings", "example.test/settings") }
            : {}),
        },
        dataUrl: `data:image/png;base64,${btoa(name)}`,
        file: new File([name], `${name}.png`, { type: "image/png" }),
      });
      onTestFinished(() => releaseChatAttachmentPayloads([attachment]));
      const onRemoveAttachment = vi.fn();
      const onAttachmentsChange = vi.fn();
      const container = renderChatView({
        attachments: [attachment],
        onAttachmentsChange,
        onRemoveAttachment,
      });
      const label = isAnnotation
        ? "Remove browser annotation: Account settings"
        : "Remove ordinary.png";
      const selector = `[aria-label="${label}"]`;
      await waitForSolid(() => expect(container.querySelector(selector)).not.toBeNull());
      requireElement(container, selector, "attachment remove button").dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
      if (isAnnotation) {
        expect(onRemoveAttachment).toHaveBeenCalledWith(attachment);
        expect(onAttachmentsChange).not.toHaveBeenCalled();
        expect(getChatAttachmentDataUrl(attachment)).not.toBeNull();
      } else {
        expect(onRemoveAttachment).not.toHaveBeenCalled();
        expect(onAttachmentsChange).toHaveBeenCalledWith([]);
        expect(getChatAttachmentDataUrl(attachment)).toBeNull();
      }
    },
  );
});
