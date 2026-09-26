/* @vitest-environment jsdom */
import { nothing, render } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import {
  createAssistantMessage,
  createAttachmentBlock,
  createMessageGroup,
} from "./chat-message.test-support.ts";
import { renderMessageGroup } from "./chat-message.ts";

const container = document.createElement("div");
afterEach(() => {
  render(nothing, container);
  vi.unstubAllGlobals();
});

it.each([
  ["audio", "recording.mp3", "audio/mpeg", "openclaw-chat-audio-player"],
  ["video", "clip.mp4", "video/mp4", "openclaw-chat-video-player"],
] as const)("renders %s attachment %s with inline playback", (kind, label, mimeType, tag) => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  const onOpenImage = vi.fn();
  const onOpenSidebar = vi.fn();
  const source = `https://example.com/${label}`;
  const message = createAssistantMessage([createAttachmentBlock(source, kind, label, mimeType)], {
    id: `assistant-${kind}-${label}-player`,
  });
  render(
    renderMessageGroup(
      createMessageGroup(message, "assistant", {
        key: "assistant-group",
        messages: [{ key: "assistant-message", message }],
      }),
      {
        showReasoning: true,
        showToolCalls: false,
        assistantName: "OpenClaw",
        assistantAvatar: null,
        onOpenImage,
        onOpenSidebar,
      },
    ),
    container,
  );
  const player = container.querySelector(tag);
  expect(player).toBeInstanceOf(HTMLElement);
  expect(player).toMatchObject({ label, mimeType, sourceIdentity: source, src: source });
  expect(container.querySelector(".chat-assistant-attachment-card--compact")).toBeNull();
  if (kind === "video") {
    container.querySelector("openclaw-chat-video-player")!.onExpand?.(source);
    expect(onOpenImage).toHaveBeenCalledWith({
      kind: "video",
      connectVideo: expect.any(Function),
      originalSrc: source,
      src: source,
      title: label,
    });
    expect(onOpenSidebar).not.toHaveBeenCalled();
  } else {
    container.querySelector("openclaw-chat-audio-player")!.onExpand?.();
    expect(onOpenSidebar).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "attachment", attachmentKind: kind, title: label }),
    );
  }
  expect(fetchMock).not.toHaveBeenCalled();
});
