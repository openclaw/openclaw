/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  getChatAttachmentDataUrl,
  registerChatAttachmentPayload,
  releaseChatAttachmentPayloads,
} from "./attachment-payload-store.ts";
import { resetChatViewState } from "./chat-view-state.ts";
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

describe("chat attachment previews", () => {
  it("renders multiple browser annotations as bounded, accessible cards", async () => {
    const annotations: ChatAttachment[] = [
      {
        id: "annotation-title",
        mimeType: "image/png",
        previewUrl: "blob:annotation-title",
        browserAnnotation: {
          modelContext: "Context for the model",
          title: "Checkout page with a deliberately long title",
          displayUrl: "shop.example.test/checkout",
          markedRegionCount: 2,
          inspectedElement: true,
        },
      },
      {
        id: "annotation-url",
        mimeType: "image/png",
        previewUrl: "blob:annotation-url",
        browserAnnotation: {
          modelContext: "Second context",
          title: "",
          displayUrl: "docs.example.test/narrow-layout",
          markedRegionCount: 1,
          inspectedElement: false,
        },
      },
    ];

    const container = renderChatView({ attachments: annotations });
    await waitForSolid(() =>
      expect(container.querySelectorAll(".chat-attachment-thumb--browser-annotation")).toHaveLength(
        2,
      ),
    );
    const cards = container.querySelectorAll<HTMLElement>(
      ".chat-attachment-thumb--browser-annotation",
    );

    expect(cards).toHaveLength(2);
    expect(cards[0]?.dataset.attachmentId).toBe("annotation-title");
    expect(cards[0]?.getAttribute("role")).toBe("group");
    expect(cards[0]?.getAttribute("aria-label")).toBe(
      "Browser annotation: Checkout page with a deliberately long title",
    );
    expect(cards[0]?.querySelector("img")?.getAttribute("alt")).toBe("Browser annotation preview");
    expect(cards[0]?.querySelector(".chat-browser-annotation-card__identity")?.textContent).toBe(
      "Checkout page with a deliberately long title",
    );
    expect(cards[0]?.querySelector(".chat-browser-annotation-card__meta")?.textContent).toContain(
      "2 marked regions",
    );
    expect(cards[0]?.textContent).not.toContain("Element inspected");
    expect(cards[1]?.querySelector(".chat-browser-annotation-card__identity")?.textContent).toBe(
      "docs.example.test/narrow-layout",
    );
    expect(cards[1]?.textContent).toContain("1 marked region");
    expect(cards[1]?.textContent).not.toContain("Element inspected");
    expect(
      cards[0]?.querySelector(
        '[aria-label="Remove browser annotation: Checkout page with a deliberately long title"]',
      ),
    ).toBeInstanceOf(HTMLButtonElement);
    for (const card of cards) {
      expect(card.querySelector(".chat-browser-annotation-card__preview")).not.toBeNull();
      expect(card.querySelector(".chat-browser-annotation-card__body")).not.toBeNull();
    }
  });

  it.each([true, false])(
    "routes attachment removal to its owner (annotation=%s)",
    async (annotation) => {
      const name = annotation ? "annotation" : "ordinary";
      const attachment = registerChatAttachmentPayload({
        attachment: {
          id: `${name}-remove`,
          fileName: `${name}.png`,
          mimeType: "image/png",
          ...(annotation
            ? {
                browserAnnotation: {
                  modelContext: "Context",
                  title: "Account settings",
                  displayUrl: "example.test/settings",
                  markedRegionCount: 0,
                  inspectedElement: false,
                },
              }
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
      const label = annotation
        ? "Remove browser annotation: Account settings"
        : "Remove ordinary.png";
      await waitForSolid(() =>
        expect(container.querySelector(`[aria-label="${label}"]`)).not.toBeNull(),
      );
      requireElement(
        container,
        `[aria-label="${label}"]`,
        "attachment remove button",
      ).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      if (annotation) {
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
