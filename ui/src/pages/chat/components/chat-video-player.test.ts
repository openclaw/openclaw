/* @vitest-environment jsdom */

import { afterEach, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { stubManualIntersectionObserver } from "./chat-media-observer.test-support.ts";
import "./chat-video-player.tsx";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type Player = HTMLElementTagNameMap["openclaw-chat-video-player"];
async function open(name: string, options: Partial<Player> = {}) {
  const player = document.createElement("openclaw-chat-video-player");
  Object.assign(player, {
    src: `https://example.com/${name}.mp4`,
    sourceIdentity: `media:${name}`,
    label: `${name}.mp4`,
    ...options,
  });
  mountSolid(() => player);
  await player.updateComplete;
  return player;
}
const card = (player: Player, suffix: string) =>
  player.querySelector(`.chat-assistant-attachment-card${suffix}`);
const expandButton = (player: Player) =>
  player.querySelector<HTMLButtonElement>(".chat-assistant-attachment-card__expand")!;
const media = (player: Player) => player.querySelector("video");
const source = (video: HTMLVideoElement | null) => video?.getAttribute("src");

it("starts metadata loading only when the video card reaches the viewport", async () => {
  let intersect: (() => void) | undefined;
  stubManualIntersectionObserver((_target, notify) => {
    intersect = () => notify(true);
  });
  const onFallbackExpand = vi.fn();
  const player = await open("clip", { sourceIdentity: "media:clip-metadata", onFallbackExpand });
  const status = player.querySelector('[role="status"]');
  const video = media(player);
  expect(video?.preload).toBe("metadata");
  expect(video?.hasAttribute("src")).toBe(false);

  const enterViewport = () => intersect?.();
  enterViewport();
  await player.updateComplete;
  expect(source(video)).toBe("https://example.com/clip.mp4");

  video!.dispatchEvent(new Event("error"));
  await player.updateComplete;
  expect(media(player)).toBeNull();
  expect(player.querySelector('[role="status"]')?.textContent).toBe(
    "clip.mp4: Preview unavailable",
  );
  expect(player.querySelector('[role="status"]')).toBe(status);
  expect(status?.getAttribute("aria-live")).toBe("polite");
  expect(status?.getAttribute("aria-atomic")).toBe("true");
  expect(player.querySelector("a[download]")?.getAttribute("href")).toBe(player.src);
  expandButton(player).click();
  expect(onFallbackExpand).toHaveBeenCalledOnce();

  player.src = "https://example.com/recovered.mp4";
  await player.updateComplete;
  expect(player.querySelector('[role="status"]')).toBe(status);
  expect(status?.textContent).toBe("");
  const recovered = media(player)!;
  expect(recovered).not.toBe(video);
  expect(recovered.hasAttribute("src")).toBe(false);
  enterViewport();
  await player.updateComplete;
  expect(source(recovered)).toBe("https://example.com/recovered.mp4");
});

it("keeps a loaded preview through rebuffering and applies a renewed ticket on resume", async () => {
  const player = await open("clip", { preview: true, src: "/media/clip.mp4?mediaTicket=A" });
  const video = media(player)!;
  const readyState = vi.spyOn(video, "readyState", "get").mockReturnValue(2);
  const paused = vi.spyOn(video, "paused", "get").mockReturnValue(true);
  const play = vi.spyOn(video, "play").mockResolvedValue();
  video.currentTime = 12;

  video.dispatchEvent(new Event("loadeddata"));
  await player.updateComplete;
  readyState.mockReturnValue(1);
  player.src = "/media/clip.mp4?mediaTicket=B";
  await player.updateComplete;
  expect(source(video)).toContain("mediaTicket=A");
  expect(player.querySelector('[aria-busy="true"]')).toBeNull();

  paused.mockReturnValue(false);
  video.dispatchEvent(new Event("play"));
  expect(source(video)).toContain("mediaTicket=B");
  video.dispatchEvent(new Event("loadedmetadata"));
  expect(play).toHaveBeenCalledOnce();
});

it("allows resolved downloads and reveals playback when loadeddata is suppressed", async () => {
  const player = await open("deferred", { preview: true, sourceIdentity: "" });
  expect(player.querySelector("a[download]")?.getAttribute("href")).toBe(player.src);
  expect(player.querySelector('[aria-busy="true"]')).not.toBeNull();
  media(player)!.dispatchEvent(new Event("playing"));
  await player.updateComplete;
  expect(player.querySelector('[aria-busy="true"]')).toBeNull();
});

it("keeps one video element mounted across 202 preparation", async () => {
  vi.useFakeTimers();
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 202 }))
    .mockResolvedValueOnce(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const onExpand = vi.fn();
  const src = "/__openclaw__/assistant-media?source=clip.avi&mediaTicket=ticket";
  const player = await open("clip", { src, playback: "transcode", onExpand });
  const video = media(player);
  await vi.waitFor(() => expect(player.textContent).toContain("Preparing playback…"));
  expect(media(player)).toBe(video);
  expect(player.querySelector('[role="status"]')?.textContent).toBe("");

  await vi.advanceTimersByTimeAsync(2_000);
  await player.updateComplete;
  expect(media(player)).toBe(video);
  expect(source(video)).toContain("mediaTicket=ticket&playback=1");
  const pause = vi.spyOn(video!, "pause").mockImplementation(() => {});
  const expand = expandButton(player);
  onExpand.mockImplementation(() => expect(document.activeElement).toBe(expand));
  expand.click();
  expect(pause).toHaveBeenCalledOnce();
  expect(onExpand).toHaveBeenCalledWith(src + "&playback=1");
});

it("does not preserve a previous attachment when a new rendition fails", async () => {
  const onExpand = vi.fn();
  const onFallbackExpand = vi.fn();
  const player = await open("first", { onExpand, onFallbackExpand });
  const failedMedia = media(player)!;
  expect(source(failedMedia)).toBe("https://example.com/first.mp4");
  const paused = vi.spyOn(failedMedia, "paused", "get").mockReturnValue(false);
  const pause = vi
    .spyOn(failedMedia, "pause")
    .mockImplementation(() => paused.mockReturnValue(true));

  const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);
  player.src = "/__openclaw__/assistant-media?source=second.caf&mediaTicket=ticket";
  player.sourceIdentity = "media:second";
  player.playback = "transcode";
  player.authToken = "new-principal";
  expect(pause).toHaveBeenCalledOnce();
  expect(fetchMock).not.toHaveBeenCalled();
  await player.updateComplete;
  expect(media(player)?.hasAttribute("src")).toBe(false);
  await vi.waitFor(() => expect(card(player, "--compact")).not.toBeNull());
  expect(card(player, "__reason")).toBeNull();
  const status = player.querySelector('[role="status"]');
  expect(status?.textContent).toBe("first.mp4: Preview unavailable");
  expect(media(player)).toBeNull();
  expect(failedMedia.isConnected).toBe(false);
  expandButton(player).click();
  expect(onFallbackExpand).toHaveBeenCalledOnce();
  expect(onExpand).not.toHaveBeenCalled();
  expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
    "Bearer new-principal",
  );

  Object.assign(player, { label: "a.caf", onMediaLoaded: vi.fn(), mediaWidth: 16, mediaHeight: 9 });
  await player.updateComplete;
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(status?.textContent).toBe("a.caf: Preview unavailable");
  player.label = "   ";
  await player.updateComplete;
  expect(status?.textContent).toBe("Video: Preview unavailable");

  fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
  player.src = "/__openclaw__/assistant-media?source=second.caf&mediaTicket=recovered";
  await player.updateComplete;
  await vi.waitFor(() =>
    expect(source(media(player))).toContain("mediaTicket=recovered&playback=1"),
  );
  expect(media(player)).not.toBe(failedMedia);
  expect(media(player)?.isConnected).toBe(true);
  expect(card(player, "--compact")).toBeNull();
  expect(player.querySelector('[role="status"]')).toBe(status);
  expect(status?.textContent).toBe("");
});

it("pauses and clears the source when disconnected while playing", async () => {
  const player = await open("playing");
  const video = media(player)!;
  const paused = vi.spyOn(video, "paused", "get").mockReturnValue(false);
  const pause = vi.spyOn(video, "pause").mockImplementation(() => paused.mockReturnValue(true));

  player.remove();
  await Promise.resolve();
  flush();
  expect(pause).toHaveBeenCalledOnce();
  expect(video.paused).toBe(true);
  expect(video.hasAttribute("src")).toBe(false);

  mountSolid(() => player);
  await vi.waitFor(() => expect(source(media(player))).toBe("https://example.com/playing.mp4"));
});
