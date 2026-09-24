import { html, nothing, render } from "lit";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import type { MessageGroup } from "../../../lib/chat/chat-types.ts";
import { renderMessageGroup } from "./chat-message-group.ts";
import { renderStreamGroup } from "./chat-message-stream.ts";
import baseCss from "../../../styles/base.css?inline";
import groupedCss from "../../../styles/chat/grouped.css?inline";
import startupCss from "../../../styles/chat/startup-layout.css?inline";
import textCss from "../../../styles/chat/text.css?inline";

let container: HTMLElement | undefined;

afterEach(() => {
  if (container) {
    render(nothing, container);
    container.remove();
    container = undefined;
  }
});

it.each(["image", "emoji", "failed image"] as const)(
  "keeps the %s avatar at the reply start as streaming content grows and settles",
  async (kind) => {
    await page.viewport(1440, 1000);
    container = document.body.appendChild(document.createElement("section"));
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 36;
    canvas.getContext("2d")!.fillRect(0, 0, 36, 36);
    const assistant = {
      agentId: "main",
      name: "Assistant",
      avatar:
        kind === "image"
          ? canvas.toDataURL("image/png")
          : kind === "failed image"
            ? "data:image/png;base64,YQ=="
            : null,
      textAvatar: "🌙",
    };
    const longReply = Array.from(
      { length: 6 },
      (_, index) => `Reply paragraph ${index + 1}: the identity stays beside the beginning.`,
    ).join("\n\n");
    for (const [text, streaming] of [
      ["Starting the reply.", true],
      [longReply, true],
      [longReply, false],
    ] as const) {
      const group: MessageGroup = {
        kind: "group",
        key: "reply",
        role: "assistant",
        timestamp: 1000,
        isStreaming: false,
        visibleContent: "text",
        messages: [
          {
            key: "reply",
            hasVisibleContent: true,
            message: { role: "assistant", content: [{ type: "text", text }] },
          },
        ],
      };
      render(
        html`<style>
            ${baseCss}${startupCss}${groupedCss}${textCss}
          </style>
          ${
            streaming
              ? renderStreamGroup(
                  [{ kind: "stream", key: "reply", text, startedAt: 1000, isStreaming: true }],
                  { assistant },
                )
              : renderMessageGroup(group, {
                  agentId: assistant.agentId,
                  assistantName: assistant.name,
                  assistantAvatar: assistant.avatar,
                  assistantTextAvatar: assistant.textAvatar,
                  showReasoning: false,
                })
          }`,
        container,
      );
      await Promise.allSettled(
        [...container.querySelectorAll<HTMLImageElement>("img.chat-avatar")].map((image) =>
          image.decode(),
        ),
      );
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
      const avatars = [...container.querySelectorAll<HTMLElement>(".chat-avatar.assistant")].filter(
        (avatar) => avatar.offsetHeight > 0 && getComputedStyle(avatar).visibility === "visible",
      );
      expect(avatars).toHaveLength(1);
      const content = container.querySelector(".chat-group-messages")!.getBoundingClientRect();
      if (text === longReply) {
        expect(content.height).toBeGreaterThan(150);
      }
      expect(avatars[0]!.getBoundingClientRect().top - content.top).toBeCloseTo(0, 1);
    }
  },
);
