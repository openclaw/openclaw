/* @vitest-environment jsdom */
import { render, nothing } from "lit";
import { afterEach, expect, it, vi } from "vitest";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { renderAssistantAttachments } from "./chat-message-attachments.ts";
import { releaseChatMediaResourceSubscriber, type AttachmentItem } from "./chat-message-media.ts";

let pause: ReturnType<typeof vi.spyOn>;
let container: HTMLDivElement | undefined;
let disconnect: (() => void) | undefined;
let update: (() => void) | undefined;
afterEach(() => {
  disconnect?.();
  disconnect = undefined;
  releaseChatMediaResourceSubscriber(update);
  update = undefined;
  if (container) {
    render(nothing, container);
    container.remove();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function open(
  attachment: AttachmentItem,
  resolveArtifactDownload?: () => Promise<{ url: string; expiresAt: string }>,
  gallery = [attachment],
) {
  pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  container = document.body.appendChild(document.createElement("div"));
  let opened: ImageLightboxItem | undefined;
  const rerender = () =>
    render(
      renderAssistantAttachments([attachment], {
        onRequestUpdate: update,
        resolveArtifactDownload,
        galleryVideos: () => ({ index: 0, items: gallery }),
        onOpenImage: (item) => {
          opened = item;
        },
      }),
      container!,
    );
  update = rerender;
  rerender();
  await vi.waitFor(() =>
    expect(container?.querySelector("openclaw-chat-video-player")).not.toBeNull(),
  );
  const player = container.querySelector("openclaw-chat-video-player")!;
  await player.updateComplete;
  player.onExpand?.(attachment.attachment.url);
  expect(opened?.connectVideo).toBeTypeOf("function");
  return opened!;
}

it("renews a selected video's ticket without interrupting playback and releases renewal on close", async () => {
  vi.useFakeTimers();
  const source = "/api/chat/media/outgoing/agent%3Amain%3Amain/" + crypto.randomUUID() + "/full";
  const resolve = vi
    .fn()
    .mockResolvedValueOnce({
      url: source + "?mediaTicket=A",
      expiresAt: new Date(Date.now() + 31_000).toISOString(),
    })
    .mockResolvedValue({
      url: source + "?mediaTicket=B",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
  const first: AttachmentItem = {
    type: "attachment",
    attachment: { kind: "video", url: "https://example.com/first.mp4", label: "First" },
  };
  const next: AttachmentItem = {
    type: "attachment",
    attachment: {
      kind: "video",
      url: source,
      artifactId: "synthetic-video",
      label: "Clip",
      mimeType: "video/mp4",
    },
  };
  const opened = await open(first, resolve, [first, next]);
  const item = await opened.gallery!.items[1]!();
  const media = container!.appendChild(document.createElement("video"));
  let paused = false;
  const play = vi.spyOn(media, "play").mockImplementation(async () => {
    paused = false;
  });
  const timersBeforeConnection = vi.getTimerCount();
  disconnect = item!.connectVideo!(media, vi.fn());
  await vi.advanceTimersByTimeAsync(0);
  expect(media.src).toContain("mediaTicket=A");
  Object.defineProperties(media, {
    paused: { configurable: true, get: () => paused },
    currentTime: { configurable: true, writable: true, value: 8 },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(media.src).toContain("mediaTicket=A");
  media.dispatchEvent(new Event("seeking"));
  expect(media.src).toContain("mediaTicket=B");
  // A native source swap resets the position and pauses until metadata arrives.
  media.currentTime = 0;
  paused = true;
  media.dispatchEvent(new Event("loadedmetadata"));
  expect(media.currentTime).toBe(8);
  expect(play).toHaveBeenCalledOnce();
  expect(paused).toBe(false);
  disconnect();
  disconnect = undefined;
  expect(media.hasAttribute("src")).toBe(false);
  expect(pause).toHaveBeenCalled();
  // This neighbor has no inline subscriber. The transcript owner remains alive;
  // only the selected connection can release its pending refresh timer here.
  expect(vi.getTimerCount()).toBe(timersBeforeConnection);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(resolve).toHaveBeenCalledTimes(2);
});

it("aborts selected rendition preparation and never assigns a late source after close", async () => {
  // The inline expansion callback is invoked directly; this test isolates the
  // modal connection from inline viewport/readiness, covered by player tests.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 200 })),
  );
  const item = await open({
    type: "attachment",
    attachment: {
      kind: "video",
      url: "https://example.com/clip.avi",
      label: "Clip",
      playback: "transcode",
    },
  });
  let complete: ((response: Response) => void) | undefined;
  let signal: AbortSignal | null | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: unknown, init?: RequestInit) => {
      signal = init?.signal;
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    }),
  );
  const media = document.createElement("video");
  const notify = vi.fn();
  disconnect = item.connectVideo!(media, notify);
  expect(notify).toHaveBeenLastCalledWith("preparing");
  expect(media.hasAttribute("src")).toBe(false);
  disconnect();
  disconnect = undefined;
  expect(signal?.aborted).toBe(true);
  complete?.(new Response(null, { status: 200 }));
  await Promise.resolve();
  await Promise.resolve();
  expect(media.hasAttribute("src")).toBe(false);
  expect(notify).not.toHaveBeenCalledWith("ready");
});

it("explicit retry clears a cached recoverable neighbor failure through its source owner", async () => {
  const first: AttachmentItem = {
    type: "attachment",
    attachment: { kind: "video", url: "https://example.com/first.mp4", label: "First" },
  };
  const url = "/api/chat/media/outgoing/agent%3Amain%3Amain/" + crypto.randomUUID() + "/full";
  const next: AttachmentItem = {
    type: "attachment",
    attachment: { kind: "video", url, artifactId: "synthetic-retry", label: "Next" },
  };
  const resolve = vi
    .fn()
    .mockRejectedValueOnce(new Error("Temporary failure"))
    .mockResolvedValue({
      url: url + "?mediaTicket=recovered",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
  const opened = await open(first, resolve, [first, next]);
  const background = vi.fn();
  try {
    const options = { resolveArtifactDownload: resolve, onRequestUpdate: background };
    renderAssistantAttachments([next], options);
    await vi.waitFor(() => expect(background).toHaveBeenCalled());
    const item = await opened.gallery!.items[1]!();
    const media = document.createElement("video");
    const notify = vi.fn();
    disconnect = item!.connectVideo!(media, notify);
    expect(notify).toHaveBeenLastCalledWith("unavailable", true);
    expect(resolve).toHaveBeenCalledTimes(1);
    disconnect();
    disconnect = item!.connectVideo!(media, notify, true);
    await vi.waitFor(() => expect(media.src).toContain("mediaTicket=recovered"));
    expect(resolve).toHaveBeenCalledTimes(2);
  } finally {
    releaseChatMediaResourceSubscriber(background);
  }
});
