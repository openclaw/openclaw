import { html, nothing, render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { en } from "../../../i18n/locales/en.ts";
import { renderGroupedMessage } from "./chat-message-bubble.ts";
import { prepareChatMessageRender } from "./chat-message-markdown.ts";
import baseCss from "../../../styles/base.css?inline";
import layoutCss from "../../../styles/chat/layout.css?inline";
import messageCss from "../../../styles/chat/message-layout.css?inline";
import textCss from "../../../styles/chat/text.css?inline";

const containers: HTMLElement[] = [];
const originalCopy = en.chat.pairingQrExpired;
afterEach(() => {
  if (originalCopy === undefined) {
    delete en.chat.pairingQrExpired;
  } else {
    en.chat.pairingQrExpired = originalCopy;
  }
  for (const container of containers.splice(0)) {
    render(nothing, container);
    container.remove();
  }
});

describe("expired pairing QR layout", () => {
  it.each([
    { width: 768, direction: "ltr", scale: 1, long: false },
    { width: 280, direction: "ltr", scale: 1.5, long: true },
    { width: 280, direction: "rtl", scale: 1.5, long: true },
  ])(
    "keeps readable insets at $width px, $direction, scale $scale",
    ({ width, direction, scale, long }) => {
      if (long) {
        en.chat.pairingQrExpired = {
          title: "A deliberately long pairing invitation title that wraps across several lines",
          badge: "Expired setup invitation",
          reason:
            "Generate a fresh setup code for VeryLongUnbrokenDeviceIdentifierThatMustNotClipAtTheCardEdge.",
        };
      }
      const container = document.body.appendChild(document.createElement("section"));
      containers.push(container);
      container.style.width = width + "px";
      container.dir = direction;
      container.style.setProperty("--control-ui-text-scale", String(scale));
      const message = {
        role: "assistant",
        content: Array.from({ length: 2 }, () => ({
          type: "openclaw_pairing_qr",
          expiresAtMs: 1,
        })),
      };
      render(
        html`<style>
            ${baseCss}${layoutCss}${messageCss}${textCss}
          </style>
          <div class="chat-group assistant">
            ${renderGroupedMessage(prepareChatMessageRender(message), "expired-qr", { isStreaming: false, showReasoning: false })}
          </div>`,
        container,
      );
      const cards = [...container.querySelectorAll<HTMLElement>(".chat-pairing-qr-expired")];
      expect(cards).toHaveLength(2);
      for (const card of cards) {
        const box = card.getBoundingClientRect();
        const reason = card.querySelector<HTMLElement>(".chat-assistant-attachment-card__reason")!;
        const title = card.querySelector<HTMLElement>(".chat-pairing-qr-expired__title")!;
        const badge = card.querySelector(".chat-pairing-qr-expired__badge")!;
        const icon = card.querySelector("svg")!.getBoundingClientRect();
        expect(box.bottom - reason.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(14);
        const edge = direction === "rtl" ? "right" : "left";
        expect(title.getBoundingClientRect()[edge]).toBeCloseTo(
          reason.getBoundingClientRect()[edge],
          1,
        );
        expect(icon.width).toBeGreaterThanOrEqual(16);
        expect(icon.height).toBeGreaterThanOrEqual(16);
        expect(getComputedStyle(badge).borderWidth).toBe("0px");
        expect(getComputedStyle(badge).backgroundColor).toBe("rgba(0, 0, 0, 0)");
        expect(getComputedStyle(badge).padding).toBe("0px");
        expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
        expect(reason.scrollWidth).toBeLessThanOrEqual(reason.clientWidth);
        expect(Number.parseFloat(getComputedStyle(title).fontSize)).toBeCloseTo(13 * scale);
      }
      expect(
        cards[1]!.getBoundingClientRect().top - cards[0]!.getBoundingClientRect().bottom,
      ).toBeGreaterThanOrEqual(8);
    },
  );
});
