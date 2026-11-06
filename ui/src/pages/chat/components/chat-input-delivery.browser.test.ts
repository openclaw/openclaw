import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { resolveTypefaces, syncTypefaceStylesheets } from "../../../app/typography.ts";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { groupMessages } from "../chat-thread-grouping.ts";
import { createMessageGroupHarness } from "./chat-message-native.test-support.tsx";
import baseCss from "../../../styles/base.css?inline";
import groupedCss from "../../../styles/chat/grouped.css?inline";
import messageCss from "../../../styles/chat/message-layout.css?inline";
import startupCss from "../../../styles/chat/startup-layout.css?inline";
import textCss from "../../../styles/chat/text.css?inline";
import identityAvatarCss from "../../../styles/identity-avatar.css?inline";
import mobileCss from "../../../styles/layout.mobile.css?inline";

let container: HTMLElement;
let stylesheet: HTMLStyleElement;
let root: ReturnType<typeof createMessageGroupHarness>;
afterEach(() => {
  root?.unmount();
  container?.remove();
  stylesheet?.remove();
});

const geometry = (element: Element) => {
  const { x, y, width, height } = element.getBoundingClientRect();
  return { x, y, width, height };
};

it.each([
  ...[320, 393, 1280].flatMap((width) =>
    (["read", "unconfirmed", "not-steered"] as const).flatMap((delivery) =>
      (["text", "image"] as const).map((kind) => ({ width, delivery, kind, shortName: false })),
    ),
  ),
  ...[320, 393].map((width) => ({
    width,
    delivery: "read" as const,
    kind: "text" as const,
    shortName: true,
  })),
])(
  "keeps $delivery in $width px grouped peer $kind metadata (short=$shortName)",
  async ({ width, delivery, kind, shortName }) => {
    await page.viewport(width, 900);
    await expect.poll(() => window.matchMedia("(max-width: 768px)").matches).toBe(width <= 768);
    stylesheet = document.createElement("style");
    stylesheet.textContent = [
      baseCss,
      identityAvatarCss,
      mobileCss,
      startupCss,
      messageCss,
      textCss,
      groupedCss,
    ].join("\n");
    document.head.append(stylesheet);
    const typefaces = resolveTypefaces("claw");
    syncTypefaceStylesheets(typefaces);
    await expect
      .poll(() =>
        Boolean(
          document.querySelector<HTMLLinkElement>("#openclaw-typeface-" + typefaces.ui)?.sheet,
        ),
      )
      .toBe(true);
    container = document.body.appendChild(document.createElement("section"));
    const outside = container.appendChild(document.createElement("button"));
    outside.textContent = "Outside message";
    const host = container.appendChild(document.createElement("div"));
    host.style.cssText = "width:calc(100vw - 32px);max-width:48rem;margin:16px";
    root = createMessageGroupHarness(host);
    const timestamp = Date.now();
    const sources = ["a", "b"].map((id, index) => ({
      kind: "message" as const,
      key: id,
      message: {
        role: "user",
        timestamp: timestamp + index,
        content:
          kind === "text"
            ? [{ type: "text", text: "Correction " + id }]
            : [
                {
                  type: "image",
                  mimeType: "image/png",
                  alt: "Steering reference " + id,
                  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
                },
              ],
        __openclaw: {
          id,
          seq: index + 1,
          idempotencyKey: id + ":user",
          steerTargetRunId: "active",
          senderId: "peer",
          senderIdentity: { type: "profile", id: "peer" },
          senderName: shortName
            ? "Morgan Lee"
            : "Alexandria Catherine Montgomery-Wellington — Release Readiness",
        },
      },
    }));
    const group = (received: boolean): MessageGroup => {
      const groups = groupMessages(
        sources.map((item) => ({
          kind: item.kind,
          key: item.key,
          message: received
            ? {
                ...item.message,
                __openclaw: {
                  ...item.message["__openclaw"],
                  inputDelivery: { delivery, seq: 1 },
                },
              }
            : item.message,
        })),
      );
      const result = groups[0];
      if (groups.length !== 1 || result?.kind !== "group") {
        throw new Error("Expected two source messages in one peer group");
      }
      return result;
    };
    const options = {
      userId: "viewer",
      showReasoning: true,
      showToolCalls: true,
      assistantName: "OpenClaw",
      assistantAvatar: null,
    };
    root.render(group(false), options);
    if (kind === "image") {
      await expect
        .poll(() => {
          const images = Array.from(host.querySelectorAll<HTMLImageElement>("img"));
          return (
            images.length === 2 && images.every((image) => image.complete && image.naturalWidth > 0)
          );
        })
        .toBe(true);
    }
    await page.elementLocator(outside).hover();
    const row = host.querySelector(".chat-group")!;
    await expect
      .poll(() => row.querySelectorAll(".chat-copy-btn, .chat-reply-btn").length)
      .toBe(kind === "text" ? 2 : 0);
    await expect
      .poll(() => row.querySelector(".chat-sender-name")?.textContent)
      .toContain(shortName ? "Morgan Lee" : "Alexandria");
    await expect
      .poll(
        () =>
          row.querySelectorAll(width <= 768 ? ".chat-message-footer" : ".chat-message-actions-row")
            .length,
      )
      .toBe(1);
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    const before = geometry(row);
    const beforeBubbles = Array.from(row.querySelectorAll(".chat-bubble"), geometry);
    root.render(group(true), options);
    await expect.poll(() => row.querySelectorAll(".chat-input-delivery").length).toBe(2);
    expect(geometry(row)).toEqual(before);
    expect(Array.from(row.querySelectorAll(".chat-bubble"), geometry)).toEqual(beforeBubbles);
    for (const name of row.querySelectorAll(".chat-sender-name")) {
      expect(geometry(name).width).toBeGreaterThan(0);
    }
    expect(row.querySelectorAll(".chat-copy-btn, .chat-reply-btn")).toHaveLength(
      kind === "text" ? 2 : 0,
    );
    const bubbles = row.querySelectorAll(".chat-bubble");
    const receipts = row.querySelectorAll<HTMLElement>(".chat-input-delivery");
    for (const [index, receipt] of Array.from(receipts).entries()) {
      await expect.poll(() => getComputedStyle(receipt).opacity).toBe("0");
      await page.elementLocator(bubbles[index]!).hover();
      await expect.poll(() => getComputedStyle(receipt).opacity).toBe("1");
      expect(geometry(row)).toEqual(before);
      const receiptBox = geometry(receipt);
      expect(receiptBox.width).toBeGreaterThan(20);
      expect(receiptBox.height).toBeGreaterThan(0);
      const footer = receipt.closest(
        ".chat-message-actions-row, .chat-message-footer, .chat-group-footer",
      )!;
      const textRects = Array.from(
        footer.querySelectorAll(".chat-sender-name, .chat-group-timestamp, .chat-input-delivery"),
        (element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const rect = range.getBoundingClientRect();
          return {
            top: rect.top,
            bottom: rect.bottom,
            timestamp: element.classList.contains("chat-group-timestamp"),
          };
        },
      );
      const timestampRect = textRects.find((rect) => rect.timestamp);
      if (!timestampRect) {
        throw new Error("Expected timestamp beside the delivery receipt");
      }
      expect(
        Math.max(...textRects.map((rect) => rect.top)) -
          Math.min(...textRects.map((rect) => rect.top)),
      ).toBeLessThanOrEqual(0.5);
      expect(
        Math.max(...textRects.map((rect) => rect.bottom)) -
          Math.min(...textRects.map((rect) => rect.bottom)),
      ).toBeLessThanOrEqual(0.5);
      const textCenter = (timestampRect.top + timestampRect.bottom) / 2;
      for (const icon of footer.querySelectorAll(
        ".chat-copy-btn svg, .chat-reply-btn svg, .chat-read-aloud-btn svg",
      )) {
        const box = icon.getBoundingClientRect();
        expect(Math.abs(box.y + box.height / 2 - textCenter)).toBeLessThanOrEqual(1);
      }
      for (const metadata of footer.querySelectorAll(".chat-sender-name, time")) {
        const box = geometry(metadata);
        const overlapX =
          Math.min(receiptBox.x + receiptBox.width, box.x + box.width) -
          Math.max(receiptBox.x, box.x);
        const overlapY =
          Math.min(receiptBox.y + receiptBox.height, box.y + box.height) -
          Math.max(receiptBox.y, box.y);
        expect(overlapX > 1 && overlapY > 1).toBe(false);
      }
      expect(host.scrollWidth - host.clientWidth).toBeLessThanOrEqual(1);
      expect(
        document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ).toBeLessThanOrEqual(1);
      await page.elementLocator(outside).hover();
      await expect.poll(() => getComputedStyle(receipt).opacity).toBe("0");
    }
  },
);
