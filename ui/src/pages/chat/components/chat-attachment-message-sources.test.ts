/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as markdown from "../../../components/markdown.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { MessageGroup } from "./chat-message-group-view.tsx";
import {
  createAssistantMessage,
  createAttachmentBlock,
  createMessageGroup,
  createUserMessage,
} from "./chat-message.test-support.ts";

let view: HTMLDivElement;
let mounted: ReturnType<typeof mountSolid> | undefined;

beforeEach(() => {
  mounted = undefined;
  view = document.body.appendChild(document.createElement("div"));
  vi.spyOn(markdown, "toSanitizedMarkdownHtml").mockImplementation((value) => value);
  vi.spyOn(markdown, "toStreamingMarkdownParts").mockImplementation((value): [string, string] => [
    "",
    `<div class="streaming-markdown">${value}</div>`,
  ]);
});

afterEach(() => {
  mounted?.dispose();
  view.remove();
  vi.restoreAllMocks();
});

function renderMessage(message: unknown, role = "assistant") {
  const group = createMessageGroup(message, role);
  mounted = mountSolid(
    MessageGroup,
    {
      group,
      options: {
        showReasoning: true,
        showToolCalls: false,
        assistantName: "OpenClaw",
        assistantAvatar: null,
      },
    },
    view,
  );
}

it("omits attachment anchors for unsafe transcript URLs", () => {
  renderMessage(
    createAssistantMessage([
      createAttachmentBlock("javascript:audio()", "audio", "unsafe.mp3", "audio/mpeg"),
      createAttachmentBlock("data:text/html,video", "video", "unsafe.mp4", "video/mp4"),
      createAttachmentBlock("vbscript:document", "document", "unsafe.pdf", "application/pdf"),
    ]),
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
  const mediaUrl = "https://cdn.example/clip%2Emp4?download=1";

  renderMessage(
    createUserMessage("", {
      __openclaw: { media: [{ url: mediaUrl, contentType: "video/mp4" }] },
    }),
    "user",
  );

  expect(
    view.querySelector(".chat-assistant-attachment-card__download")?.getAttribute("href"),
  ).toBe(mediaUrl);
  expect(view.querySelector("video, openclaw-chat-video-player")).toBeNull();
});

it("deduplicates one SVG represented by structured and persisted media facts", async () => {
  const source = "https://cdn.example/duplicate.svg";
  renderMessage(
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
  );

  await vi.waitFor(() =>
    expect(view.querySelectorAll(".chat-assistant-attachment-card--compact")).toHaveLength(1),
  );
});
