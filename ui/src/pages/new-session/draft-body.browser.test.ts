import { html, nothing, render } from "lit";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { releaseChatAttachmentPayload } from "../chat/attachment-payload-store.ts";
import { buildLocalUserMessage } from "../chat/user-message-content.ts";
import { renderNewSessionBody } from "./draft-body.ts";
import baseStyles from "../../styles/base.css?inline";

const container = document.createElement("div");
const styles = document.createElement("style");

afterEach(() => {
  render(nothing, container);
  container.remove();
  styles.remove();
  releaseChatAttachmentPayload("startup-notes");
});

it.each([
  { width: 390, text: "Read this document before we discuss it." },
  { width: 1280, text: "" },
])("keeps submitted files outside the painted text at $width px", async ({ width, text }) => {
  await page.viewport(width, 800);
  styles.textContent = baseStyles;
  document.head.append(styles);
  container.className = "new-session-page chat";
  document.body.append(container);
  render(
    renderNewSessionBody({
      error: null,
      pendingMessage: buildLocalUserMessage({
        createdAt: Date.now(),
        text,
        attachments: [
          {
            id: "startup-notes",
            fileName: "notes.md",
            mimeType: "text/markdown",
            dataUrl: "data:text/markdown;base64,IyBOb3Rlcw==",
          },
        ],
      }),
      submitting: true,
      renderDraft: () => html``,
      onOpenImage: () => {},
    }),
    container,
  );
  await expect.element(page.getByText("notes.md", { exact: true })).toBeVisible();
  const bubble = container.querySelector<HTMLElement>(".chat-group.user .chat-bubble")!;
  const card = bubble.querySelector<HTMLElement>(".chat-assistant-attachment-card")!;
  expect(getComputedStyle(bubble).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  expect(getComputedStyle(bubble).padding).toBe("0px");
  const cardBox = card.getBoundingClientRect();
  expect(cardBox.width).toBeGreaterThan(200);
  expect(cardBox.right).toBeLessThanOrEqual(width);
  const message = bubble.querySelector<HTMLElement>(".chat-text");
  if (text) {
    expect(message?.textContent).toContain(text);
    expect(getComputedStyle(message!).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(cardBox.bottom).toBeLessThanOrEqual(message!.getBoundingClientRect().top);
  } else {
    expect(message).toBeNull();
  }
});
