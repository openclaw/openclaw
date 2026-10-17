/* @vitest-environment jsdom */
import { createComponent } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { AssistantAttachments } from "./chat-message-attachments-solid.tsx";
import { releaseChatMediaResourceOwner } from "./chat-message-media.ts";
import type { AttachmentItem, ImageRenderOptions } from "./chat-message-media.ts";
let pause: ReturnType<typeof vi.spyOn>;
let container: HTMLDivElement | undefined;
let disconnect: (() => void) | undefined;
const cleanups: (() => void)[] = [];
afterEach(() => {
  disconnect?.();
  disconnect = undefined;
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function video(url: string, options: Partial<AttachmentItem["attachment"]> = {}): AttachmentItem {
  return { type: "attachment", attachment: { kind: "video", url, label: "Clip", ...options } };
}
function mount(attachment: AttachmentItem, options: ImageRenderOptions) {
  const view = mountSolid(() =>
    createComponent(AssistantAttachments, { attachments: [attachment], options }),
  );
  cleanups.push(() => {
    view.unmount();
    releaseChatMediaResourceOwner(options.mediaOwner);
  });
  return view;
}
const outgoing = () => `/api/chat/media/outgoing/agent%3Amain%3Amain/${crypto.randomUUID()}/full`;
const ticket = (source: string, value: string, ttl = 300_000) => ({
  url: `${source}?mediaTicket=${value}`,
  expiresAt: new Date(Date.now() + ttl).toISOString(),
});
async function open(
  attachment: AttachmentItem,
  resolveArtifactDownload?: ImageRenderOptions["resolveArtifactDownload"],
  gallery = [attachment],
) {
  pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  const onOpenImage = vi.fn<(item: ImageLightboxItem) => void>();
  const view = mount(attachment, {
    mediaOwner: {},
    resolveArtifactDownload,
    galleryVideos: () => ({ index: 0, items: gallery }),
    onOpenImage,
  });
  container = view.container;
  await vi.waitFor(() =>
    expect(container?.querySelector("openclaw-chat-video-player")).not.toBeNull(),
  );
  const player = container.querySelector("openclaw-chat-video-player")!;
  await player.updateComplete;
  player.onExpand?.(attachment.attachment.url);
  const opened = onOpenImage.mock.lastCall?.[0];
  expect(opened?.connectVideo).toBeTypeOf("function");
  return opened!;
}

it("renews a selected video's ticket without interrupting playback and releases renewal on close", async () => {
  vi.useFakeTimers();
  const source = outgoing();
  const resolve = vi.fn().mockResolvedValue(ticket(source, "B"));
  resolve.mockResolvedValueOnce(ticket(source, "A", 31_000));
  const first = video("https://example.com/first.mp4");
  const next = video(source, { artifactId: "synthetic-video" });
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
  expect(media).toMatchObject({ currentTime: 8, paused: false });
  expect(play).toHaveBeenCalledOnce();
  disconnect();
  disconnect = undefined;
  expect(media.hasAttribute("src")).toBe(false);
  expect(pause).toHaveBeenCalled();
  // The transcript owner remains alive; only closing this neighbor releases its timer.
  expect(vi.getTimerCount()).toBe(timersBeforeConnection);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(resolve).toHaveBeenCalledTimes(2);
});

it("aborts selected rendition preparation and never assigns a late source after close", async () => {
  const ready = new Response(null, { status: 200 });
  const request = vi.fn<typeof fetch>().mockResolvedValue(ready);
  vi.stubGlobal("fetch", request);
  const item = await open(video("https://example.com/clip.avi", { playback: "transcode" }));
  const pending = Promise.withResolvers<Response>();
  request.mockImplementation(() => pending.promise);
  const media = document.createElement("video");
  const notify = vi.fn();
  disconnect = item.connectVideo!(media, notify);
  expect(notify).toHaveBeenLastCalledWith("preparing");
  expect(media.hasAttribute("src")).toBe(false);
  disconnect();
  disconnect = undefined;
  expect(request.mock.lastCall?.[1]?.signal?.aborted).toBe(true);
  pending.resolve(ready);
  await Promise.resolve();
  await Promise.resolve();
  expect(media.hasAttribute("src")).toBe(false);
  expect(notify).not.toHaveBeenCalledWith("ready");
});

it("explicit retry clears a cached recoverable neighbor failure through its source owner", async () => {
  const url = outgoing();
  const next = video(url, { artifactId: "synthetic-retry" });
  const resolve = vi.fn().mockResolvedValue(ticket(url, "recovered"));
  resolve.mockRejectedValueOnce(new Error("Temporary failure"));
  const first = video("https://example.com/first.mp4");
  const opened = await open(first, resolve, [first, next]);
  const backgroundView = mount(next, { resolveArtifactDownload: resolve, mediaOwner: {} });
  const retry = () =>
    backgroundView.container.querySelector(".chat-assistant-attachment-card__retry");
  await vi.waitFor(() => expect(retry()).not.toBeNull());
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
});
