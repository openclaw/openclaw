/* @vitest-environment jsdom */

import { html, nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as markdown from "../../../components/markdown.ts";
import * as chatAvatar from "../chat-avatar.ts";
import { renderMessageGroup } from "./chat-message-group.ts";
import {
  createAssistantMessage,
  createAttachmentBlock,
  createMessageGroup,
  createUserMessage,
} from "./chat-message.test-support.ts";

let view: HTMLDivElement;
const renderedContainers = new Set<HTMLElement>();

beforeEach(() => {
  view = document.createElement("div");
  vi.spyOn(markdown, "toSanitizedMarkdownHtml").mockImplementation((value) => value);
  vi.spyOn(markdown, "toStreamingMarkdownParts").mockImplementation((value): [string, string] => [
    "",
    `<div class="streaming-markdown">${value}</div>`,
  ]);
  vi.spyOn(chatAvatar, "renderChatAvatar").mockImplementation(
    (role) => html`<div class="chat-avatar ${role}"></div>`,
  );
});

afterEach(() => {
  for (const container of renderedContainers) {
    render(nothing, container);
    container.remove();
  }
  renderedContainers.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type RenderOptions = Parameters<typeof renderMessageGroup>[1];

function renderGroupedMessage(
  message: unknown,
  role: string,
  opts: Partial<RenderOptions> = {},
  container: HTMLElement = view,
) {
  renderedContainers.add(container);
  const group = createMessageGroup(message, role, {
    key: `${role}-group`,
    messages: [{ key: `${role}-message`, message }],
  });
  render(
    renderMessageGroup(group, {
      showReasoning: true,
      showToolCalls: true,
      assistantName: "OpenClaw",
      assistantAvatar: null,
      ...opts,
    }),
    container,
  );
}

function renderAssistantMessage(
  message: unknown,
  opts: Partial<RenderOptions> = {},
  container: HTMLElement = view,
) {
  renderGroupedMessage(message, "assistant", opts, container);
}

function attachmentDownload(container: Element) {
  return container.querySelector<HTMLAnchorElement>(".chat-assistant-attachment-card__download");
}

describe("transcript attachment sources", () => {
  it("omits attachment anchors for unsafe transcript URLs", () => {
    document.body.append(view);

    renderAssistantMessage(
      createAssistantMessage(
        [
          createAttachmentBlock("javascript:audio()", "audio", "unsafe.mp3", "audio/mpeg"),
          createAttachmentBlock("data:text/html,video", "video", "unsafe.mp4", "video/mp4"),
          createAttachmentBlock("vbscript:document", "document", "unsafe.pdf", "application/pdf"),
        ],
        { id: "assistant-unsafe-attachment-links" },
      ),
      { showToolCalls: false },
    );

    expect(view.querySelectorAll(".chat-assistant-attachments a")).toHaveLength(0);
    expect(
      view.querySelector(
        "openclaw-chat-audio-player, openclaw-chat-video-player, audio, video, iframe, table",
      ),
    ).toBeNull();
    expect(view.textContent).toContain("unsafe.pdf");
  });

  it("renders transcript video URLs with encoded extensions as cards", () => {
    const container = document.body.appendChild(document.createElement("div"));
    const mediaUrl = "https://cdn.example/clip%2Emp4?download=1";

    renderGroupedMessage(
      createUserMessage("", {
        id: "user-encoded-video",
        __openclaw: { media: [{ url: mediaUrl, contentType: "video/mp4" }] },
      }),
      "user",
      { showToolCalls: false },
      container,
    );

    expect(attachmentDownload(container)?.getAttribute("href")).toBe(mediaUrl);
    expect(container.querySelector("video, openclaw-chat-video-player")).toBeNull();
  });

  it("deduplicates one SVG represented by structured and persisted media facts", async () => {
    const source = "https://cdn.example/duplicate.svg";
    const container = document.body.appendChild(document.createElement("div"));
    renderAssistantMessage(
      createAssistantMessage([{ type: "image_url", image_url: { url: source } }], {
        __openclaw: {
          media: [
            {
              path: source,
              contentType: "image/svg+xml",
              fileName: "duplicate.svg",
              sizeBytes: 300_000,
            },
          ],
        },
      }),
      { showToolCalls: false },
      container,
    );

    await vi.waitFor(() =>
      expect(container.querySelectorAll(".chat-assistant-attachment-card--compact")).toHaveLength(
        1,
      ),
    );
    container.remove();
  });
});
