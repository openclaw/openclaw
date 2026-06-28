/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it } from "vitest";
import { renderMessageGroup } from "./grouped-render.ts";
import type { MessageGroup } from "../types/chat-types.ts";

function renderGroup(messages: unknown[]) {
  const container = document.createElement("div");
  const group: MessageGroup = {
    kind: "group",
    key: "group:assistant:test",
    role: "assistant",
    senderLabel: null,
    messages: messages.map((message, index) => ({
      key: `message:${index}`,
      message,
    })),
    timestamp: 1,
    isStreaming: false,
  };
  render(
    renderMessageGroup(group, {
      showReasoning: false,
      showToolCalls: true,
      assistantName: "Val",
      assistantAvatar: null,
      userName: null,
      userAvatar: null,
      localMediaPreviewRoots: [],
      assistantAttachmentAuthToken: null,
    }),
    container,
  );
  return container;
}

describe("grouped chat attachment rendering", () => {
  it("renders audio attachments with a player and download action", () => {
    const container = renderGroup([
      {
        role: "assistant",
        content: [
          {
            type: "attachment",
            attachment: {
              url: "data:audio/mpeg;base64,AAAA",
              kind: "audio",
              label: "briefing.mp3",
              mimeType: "audio/mpeg",
            },
          },
        ],
      },
    ]);

    const audio = container.querySelector("audio");
    expect(audio).toBeInstanceOf(HTMLAudioElement);
    expect(audio?.getAttribute("controls")).toBe("");
    const download = container.querySelector<HTMLAnchorElement>(
      'a.chat-assistant-attachment-card__action[download="briefing.mp3"]',
    );
    expect(download?.textContent).toContain("Download");
    expect(download?.getAttribute("href")).toBe("data:audio/mpeg;base64,AAAA");
  });

  it("renders document attachments with open and download actions", () => {
    const container = renderGroup([
      {
        role: "assistant",
        content: [
          {
            type: "attachment",
            attachment: {
              url: "data:application/pdf;base64,JVBERi0xLjQK",
              kind: "document",
              label: "report.pdf",
              mimeType: "application/pdf",
            },
          },
        ],
      },
    ]);

    const card = container.querySelector(".chat-assistant-attachment-card--document");
    expect(card).toBeInstanceOf(HTMLElement);
    expect(card?.textContent).toContain("report.pdf");
    expect(container.querySelector("object.chat-assistant-attachment-card__pdf")).toBeInstanceOf(
      HTMLObjectElement,
    );
    const actions = [...container.querySelectorAll<HTMLAnchorElement>(
      ".chat-assistant-attachment-card__action",
    )].map((link) => [link.textContent?.trim(), link.getAttribute("download")]);
    expect(actions).toEqual([
      ["Open", null],
      ["Download", "report.pdf"],
    ]);
  });
});
