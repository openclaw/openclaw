/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import "./chat-audio-player.tsx";
import { CHAT_AUDIO_WAVEFORM_MAX_BYTES } from "./chat-audio-waveform.ts";

type ChatAudioPlayer = HTMLElementTagNameMap["openclaw-chat-audio-player"];

const audio = (player: ChatAudioPlayer) => player.querySelector("audio")!;
const downloadLink = (player: ChatAudioPlayer) =>
  player.querySelector<HTMLAnchorElement>("a[download]")!;
const headerDownload = (player: ChatAudioPlayer) =>
  player.querySelector<HTMLAnchorElement>(".chat-assistant-attachment-card__download");
const waveformElement = (player: ChatAudioPlayer) =>
  player.querySelector(".chat-audio-player__waveform");
const waveformRects = (player: ChatAudioPlayer) =>
  player.querySelectorAll(".chat-audio-player__waveform rect");
const seekInput = (player: ChatAudioPlayer) =>
  player.querySelector<HTMLInputElement>(".chat-audio-player__seek")!;
const source = (player: ChatAudioPlayer) => player.querySelector("audio")?.getAttribute("src");
function pendingFetch() {
  let resolve!: (response: Response) => void;
  const fetchMock = vi.fn<typeof fetch>(
    async () =>
      await new Promise<Response>((respond) => {
        resolve = respond;
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, resolve: (response: Response) => resolve(response) };
}
async function update(player: ChatAudioPlayer, properties: Partial<ChatAudioPlayer>) {
  Object.assign(player, properties);
  await player.updateComplete;
}
async function fail(player: ChatAudioPlayer) {
  audio(player).dispatchEvent(new Event("error"));
  await player.updateComplete;
}
function transcodePlayer() {
  return createPlayer("voice", {
    src: "/__openclaw__/assistant-media?source=voice.caf&mediaTicket=ticket",
    sourceIdentity: "/tmp/voice.caf",
    label: "voice.caf",
    playback: "transcode",
  });
}
function expectUnavailable(player: ChatAudioPlayer) {
  expect(card(player, "--compact")).not.toBeNull();
  expect(card(player, "__reason")).toBeNull();
  expect(player.querySelector(".chat-audio-player")).toBeNull();
}
const control = (player: ChatAudioPlayer, suffix: string) =>
  player.querySelector<HTMLButtonElement>(`.chat-audio-player__${suffix}`)!;
const card = (player: ChatAudioPlayer, suffix = "") =>
  player.querySelector<HTMLElement>(`.chat-assistant-attachment-card${suffix}`);
const times = (player: ChatAudioPlayer) =>
  Array.from(player.querySelectorAll(".chat-audio-player__time span"), (item) =>
    item.textContent?.trim(),
  );
const audioResponse = () =>
  new Response(new Uint8Array([1, 2, 3, 4]), {
    status: 200,
    headers: { "Content-Type": "audio/mpeg", "Content-Length": "4" },
  });
function mockPlayback(media: HTMLMediaElement, active = false, events = true, pauseEvent = events) {
  let paused = !active;
  Object.defineProperty(media, "paused", { configurable: true, get: () => paused });
  return {
    play: vi.spyOn(media, "play").mockImplementation(async () => {
      if (!active) {
        paused = false;
      }
      if (events) {
        media.dispatchEvent(new Event("play"));
      }
    }),
    pause: vi.spyOn(media, "pause").mockImplementation(() => {
      paused = true;
      if (pauseEvent) {
        media.dispatchEvent(new Event("pause"));
      }
    }),
  };
}
function setMediaNumber(
  media: HTMLMediaElement,
  property: "currentTime" | "duration",
  value: number,
) {
  Object.defineProperty(media, property, { configurable: true, writable: true, value });
}
function mockActivePlayback(media: HTMLMediaElement) {
  setMediaNumber(media, "currentTime", 20);
  setMediaNumber(media, "duration", 80);
  return mockPlayback(media, true, false);
}
function mockPlay(media: HTMLMediaElement) {
  Object.defineProperty(media, "paused", { configurable: true, value: true });
  return vi.spyOn(media, "play").mockResolvedValue(undefined);
}
async function createPlayer(
  label: string,
  overrides: Partial<ChatAudioPlayer> = {},
): Promise<ChatAudioPlayer> {
  const player = document.createElement("openclaw-chat-audio-player");
  player.src = `https://example.com/${label}.mp3`;
  player.sourceIdentity = `media://${label}`;
  player.label = `${label}.mp3`;
  Object.assign(player, overrides);
  mountSolid(() => player);
  await player.updateComplete;
  return player;
}

function observeIntersections() {
  const callbacks: Array<() => void> = [];
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      private readonly targets = new Set<Element>();
      constructor(private readonly callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        this.targets.add(target);
        callbacks.push(() => {
          if (this.targets.has(target)) {
            // SAFETY: The viewport owner reads only target and isIntersecting.
            this.callback(
              [{ target, isIntersecting: true } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            );
          }
        });
      }
      unobserve(target: Element) {
        this.targets.delete(target);
      }
      disconnect() {
        this.targets.clear();
      }
    },
  );
  return () => callbacks.shift()?.();
}

function stubAudioContext(decodeAudioData = vi.fn()) {
  vi.stubGlobal(
    "AudioContext",
    class {
      decodeAudioData = decodeAudioData;
      close = vi.fn(async () => undefined);
    },
  );
  return decodeAudioData;
}

function decodedAudio(duration: number) {
  const samples = new Float32Array([0, 0.5, -1, 0.25]);
  return {
    duration,
    length: samples.length,
    numberOfChannels: 1,
    getChannelData: () => samples,
  };
}

function mockAudioContext() {
  return stubAudioContext(vi.fn(async () => decodedAudio(4)));
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatAudioPlayer", () => {
  it("keeps voice notes player-only and never opens the attachment sidebar", async () => {
    const player = await createPlayer("voice-note");
    await update(player, { voiceNote: true, onExpand: vi.fn(), sizeBytes: 2048 });
    expect(player.querySelector(".chat-assistant-attachment-card__header")).toBeNull();
    expect(player.querySelector(".chat-attachment-file-icon, [data-openable]")).toBeNull();
    expect(player.textContent).not.toContain("voice-note.mp3");
    expect(player.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Voice note");
    player.querySelector<HTMLElement>(".chat-assistant-attachment-card")!.click();
    expect(player.onExpand).not.toHaveBeenCalled();
    await fail(player);
    expect(player.querySelector("audio, .chat-audio-player__toggle")).toBeNull();
    expect(player.querySelectorAll("[role=status]")).toHaveLength(1);
    expect(player.querySelector("[role=status]")?.textContent).toContain("Preview unavailable");
    expect(downloadLink(player)).toMatchObject({
      href: "https://example.com/voice-note.mp3",
      target: "_blank",
      rel: "noreferrer",
    });
    expect(card(player, "__expand")).toBeNull();
  });

  it("drives play, pause, seek, and keyboard state through the hidden audio element", async () => {
    const inline = "data:audio/wav;base64,UklGRg==";
    const player = await createPlayer("briefing", { src: inline });
    expect(headerDownload(player)?.getAttribute("href")).toBe(inline);
    const media = audio(player);
    expect(times(player)).toEqual(["0:00 / 0:00"]);
    Object.defineProperty(media, "buffered", {
      configurable: true,
      value: { length: 1, end: () => 1_832.5 },
    });
    setMediaNumber(media, "duration", 3_665);
    setMediaNumber(media, "currentTime", 65.9);
    media.dispatchEvent(new Event("loadedmetadata"));
    await player.updateComplete;
    expect(times(player)).toEqual(["1:05 / 61:05"]);
    expect(seekInput(player).style.getPropertyValue("--chat-audio-buffered")).toBe("50%");
    setMediaNumber(media, "duration", 125);
    setMediaNumber(media, "currentTime", 0);
    const { play, pause } = mockPlayback(media);
    media.dispatchEvent(new Event("loadedmetadata"));
    await player.updateComplete;
    expect(times(player)).toEqual(["0:00 / 2:05"]);
    control(player, "toggle").click();
    await waitForSolid(() => expect(play).toHaveBeenCalledOnce());
    await waitForSolid(() =>
      expect(control(player, "toggle")?.getAttribute("aria-label")).toBe("Pause"),
    );
    expect(headerDownload(player)?.getAttribute("download")).toBe("briefing.mp3");
    const seek = seekInput(player);
    seek.value = "35";
    seek.dispatchEvent(new Event("input", { bubbles: true }));
    expect(media.currentTime).toBe(35);
    for (const [key, time] of [
      ["ArrowRight", 40],
      ["ArrowUp", 45],
      ["ArrowLeft", 40],
      ["ArrowDown", 35],
    ] as const) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      seek.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(media.currentTime).toBe(time);
    }
    const controls = player.querySelector<HTMLElement>(".chat-audio-player")!;
    controls.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(media.currentTime).toBe(40);
    controls.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(pause).toHaveBeenCalledOnce();
    await player.updateComplete;
    expect(times(player)).toEqual(["0:40 / 2:05"]);
  });

  it("does not expand the attachment when muting through the changing SVG icon", async () => {
    const player = await createPlayer("voice");
    player.onExpand = vi.fn();
    await player.updateComplete;
    const icon = player.querySelector(".chat-audio-player__volume svg polygon")!;
    icon.addEventListener("click", () => icon.remove(), { once: true });
    icon.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const media = audio(player);
    expect(media.muted).toBe(true);
    const volume = player.querySelector<HTMLButtonElement>(".chat-audio-player__volume")!;
    volume.click();
    expect(media.muted).toBe(false);
    volume.click();
    expect(media.muted).toBe(true);
    await player.updateComplete;
    expect(audio(player).muted).toBe(true);
    expect(player.onExpand).not.toHaveBeenCalled();
  });

  it("announces unavailable audio while preserving its download and recovery", async () => {
    const first = await createPlayer("broken");
    const status = first.querySelector('[role="status"]');
    expect(status?.textContent).toBe("");
    const firstMedia = audio(first);
    const { play, pause: pauseFirst } = mockPlayback(firstMedia, false, true, false);
    control(first, "toggle").click();
    await first.updateComplete;
    expect(play).toHaveBeenCalledOnce();
    expect(control(first, "toggle")?.getAttribute("aria-label")).toBe("Pause");
    firstMedia.dispatchEvent(new Event("error"));
    await first.updateComplete;
    expect(first.querySelector(".chat-audio-player__toggle")).toBeNull();
    expectUnavailable(first);
    expect(first.querySelector('[role="status"]')).toBe(status);
    expect(status?.textContent).toBe("broken.mp3: Preview unavailable");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.getAttribute("aria-atomic")).toBe("true");
    expect(headerDownload(first)?.getAttribute("download")).toBe("broken.mp3");
    expect(pauseFirst).toHaveBeenCalledOnce();
    pauseFirst.mockClear();
    const second = await createPlayer("working");
    audio(second).dispatchEvent(new Event("play"));
    expect(pauseFirst).not.toHaveBeenCalled();
    first.src = "https://example.com/broken.mp3?renewed";
    await waitForSolid(() => expect(control(first, "toggle")).not.toBeNull());
    expect(first.querySelector('[role="status"]')).toBe(status);
    expect(status?.textContent).toBe("");
    await fail(first);
    expect(status?.textContent).toBe("broken.mp3: Preview unavailable");
    first.src = "https://example.com/replacement.mp3";
    first.sourceIdentity = "media://replacement";
    first.label = "replacement.mp3";
    await waitForSolid(() => expect(control(first, "toggle")).not.toBeNull());
    expect(status?.textContent).toBe("");
    await fail(first);
    expect(status?.textContent).toBe("replacement.mp3: Preview unavailable");
  });

  it.each([false, true])(
    "hands departing player focus to Download without taking outside focus (voice note: %s)",
    async (voiceNote) => {
      const outside = document.createElement("button");
      outside.textContent = "Outside player";
      document.body.append(outside);
      for (const target of ["toggle", "volume", "seek", "group", "outside", "moved"]) {
        const player = await createPlayer("focus-" + target, { voiceNote });
        const focused =
          target === "outside"
            ? outside
            : target === "group"
              ? player.querySelector<HTMLElement>(".chat-audio-player")!
              : control(player, target === "moved" ? "toggle" : target);
        focused.focus();
        expect(document.activeElement).toBe(focused);
        audio(player).dispatchEvent(new Event("error"));
        if (target === "moved") {
          outside.focus();
        }
        await player.updateComplete;
        const download = downloadLink(player);
        expect(download.getAttribute("download")).toBe("focus-" + target + ".mp3");
        expect(document.activeElement).toBe(
          target === "outside" || target === "moved" ? outside : download,
        );
      }
    },
  );

  it("keeps header Download focused when the parent Expand callback changes", async () => {
    const player = await createPlayer("callback-focus", { onExpand: vi.fn() });
    const download = headerDownload(player)!;
    download.focus();
    expect(document.activeElement).toBe(download);
    player.onExpand = vi.fn();
    await player.updateComplete;
    expect(document.activeElement).toBe(download);
  });

  it.each(["download", "expand", "outside"])(
    "preserves %s focus when playback preparation fails",
    async (target) => {
      let respond!: (response: Response) => void;
      vi.stubGlobal(
        "fetch",
        vi.fn(
          () =>
            new Promise<Response>((resolve) => {
              respond = resolve;
            }),
        ),
      );
      const outside = document.createElement("button");
      outside.textContent = "Outside player";
      document.body.append(outside);
      const player = await createPlayer("preparing-focus", {
        playback: "transcode",
        onExpand: vi.fn(),
      });
      await waitForSolid(() => expect(player.textContent).toContain("Preparing playback…"));
      const focused =
        target === "outside"
          ? outside
          : player.querySelector<HTMLElement>(`.chat-assistant-attachment-card__${target}`)!;
      focused.focus();
      expect(document.activeElement).toBe(focused);
      respond(new Response(null, { status: 500 }));
      await waitForSolid(() => expect(card(player, "--compact")).not.toBeNull());
      expect(document.activeElement).toBe(target === "outside" ? outside : downloadLink(player));
    },
  );

  it("falls back to a normal attachment card after rendition retries are exhausted", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const player = await transcodePlayer();
    await vi.runAllTimersAsync();
    await player.updateComplete;
    expectUnavailable(player);
    expect(headerDownload(player)?.getAttribute("href")).not.toContain("playback=1");
    const failedAttempts = fetchMock.mock.calls.length;
    await update(player, {
      label: "renamed-voice.caf",
      onMediaLoaded: vi.fn(),
      sizeBytes: 2048,
      serverDurationMs: 4000,
    });
    await vi.runAllTimersAsync();
    expect(fetchMock).toHaveBeenCalledTimes(failedAttempts);
    expect(player.querySelector("audio")).toBeNull();
    expect(card(player, "--compact")).not.toBeNull();
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    player.src = "/__openclaw__/assistant-media?source=voice.caf&mediaTicket=recovered";
    await player.updateComplete;
    await vi.runAllTimersAsync();
    await player.updateComplete;
    expect(card(player, "--compact")).toBeNull();
    expect(source(player)).toContain("mediaTicket=recovered&playback=1");
  });

  it("renders decoded waveform peaks and scopes waveform cache reuse to auth context", async () => {
    const intersect = observeIntersections();
    const decodeAudioData = mockAudioContext();
    const { fetchMock, resolve: resolveFetch } = pendingFetch();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:waveform-audio");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const player = await createPlayer("waveform-reuse");
    const initialPlay = mockPlay(audio(player));
    control(player, "toggle").click();
    await initialPlay.mock.results[0]!.value;
    await Promise.resolve();
    flush();
    expect(waveformElement(player)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(decodeAudioData).not.toHaveBeenCalled();
    initialPlay.mockRestore();
    player.serverDurationMs = 4_000;
    await player.updateComplete;
    expect(fetchMock).not.toHaveBeenCalled();
    intersect();
    await waitForSolid(() => expect(fetchMock).toHaveBeenCalledOnce());
    const media = audio(player);
    const { play } = mockPlayback(media);
    resolveFetch?.(audioResponse());
    await waitForSolid(() => expect(waveformRects(player)).toHaveLength(96));
    await player.updateComplete;
    expect(
      new Set(Array.from(waveformRects(player), (rect) => rect.getAttribute("height"))).size,
    ).toBeGreaterThan(1);
    player.voiceNote = true;
    await player.updateComplete;
    const voiceHeights = Array.from(waveformRects(player), (rect) =>
      Number(rect.getAttribute("height")),
    );
    expect(Math.min(...voiceHeights)).toBeGreaterThanOrEqual(6);
    expect(Math.max(...voiceHeights)).toBeLessThanOrEqual(14);
    expect(new Set(voiceHeights).size).toBeGreaterThan(1);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(decodeAudioData).toHaveBeenCalledOnce();
    expect(media.getAttribute("src")).toBe("blob:waveform-audio");
    control(player, "toggle").click();
    await waitForSolid(() => expect(play).toHaveBeenCalledOnce());
    expect(media.getAttribute("src")).toBe("blob:waveform-audio");
    expect(fetchMock).toHaveBeenCalledOnce();
    player.authToken = "new-principal";
    await player.updateComplete;
    expect(media.getAttribute("src")).toBe("https://example.com/waveform-reuse.mp3");
    player.remove();
    const refreshed = await createPlayer("waveform-reuse", {
      src: "https://example.com/waveform-reuse.mp3?mediaTicket=fresh",
      authToken: "different-principal",
      serverDurationMs: 4_000,
    });
    intersect();
    const refreshedMedia = refreshed.querySelector("audio")!;
    mockPlay(refreshedMedia);
    await waitForSolid(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    resolveFetch?.(new Response(null, { status: 500 }));
  });

  it.each(["unmount", "attachment replacement"])(
    "retires the waveform and stops playback on %s",
    async (change) => {
      const intersect = observeIntersections();
      mockAudioContext();
      const observe = vi.fn();
      const disconnect = vi.fn();
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe = observe;
          disconnect = disconnect;
        },
      );
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(
            new Response(new Uint8Array([1, 2, 3, 4]), {
              headers: { "Content-Type": "audio/mpeg", "Content-Length": "4" },
            }),
          )
          .mockResolvedValue(new Response(null, { status: 500 })),
      );
      vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:waveform-disposal");
      const label = change === "unmount" ? "waveform-unmount" : "waveform-replacement";
      const player = await createPlayer(label, { serverDurationMs: 4_000 });
      intersect();
      await waitForSolid(() => expect(waveformElement(player)).not.toBeNull());
      const waveform = waveformElement(player)!;
      const media = player.querySelector("audio")!;
      expect(observe).toHaveBeenCalledExactlyOnceWith(waveform);
      expect(disconnect).not.toHaveBeenCalled();
      expect(media.getAttribute("src")).toBe("blob:waveform-disposal");
      const { pause } = mockActivePlayback(media);
      if (change === "unmount") {
        player.remove();
        await Promise.resolve();
        flush();
        expect(media.hasAttribute("src")).toBe(false);
      } else {
        player.src = "https://example.com/replacement.mp3";
        player.sourceIdentity = "media://replacement";
        await waitForSolid(() =>
          expect(media.getAttribute("src")).toBe("https://example.com/replacement.mp3"),
        );
      }
      expect(waveform.isConnected).toBe(false);
      expect(disconnect).toHaveBeenCalledOnce();
      expect(pause).toHaveBeenCalledOnce();
    },
  );

  it("recovers a waveform-backed source after a renewed media ticket", async () => {
    const intersect = observeIntersections();
    mockAudioContext();
    let resolveFirstFetch: ((response: Response) => void) | undefined;
    let fetchCount = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      fetchCount += 1;
      if (fetchCount > 1) {
        return new Response(null, { status: 500 });
      }
      return await new Promise<Response>((resolve) => {
        resolveFirstFetch = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:waveform-audio");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const player = await createPlayer("waveform-recovery");
    player.serverDurationMs = 4_000;
    await player.updateComplete;
    intersect();
    await waitForSolid(() => expect(fetchMock).toHaveBeenCalledOnce());
    resolveFirstFetch?.(audioResponse());
    await waitForSolid(() => expect(source(player)).toBe("blob:waveform-audio"));
    const media = audio(player);
    Object.defineProperty(media, "error", { configurable: true, value: {} as MediaError });
    media.dispatchEvent(new Event("error"));
    await player.updateComplete;
    expect(card(player, "--compact")).not.toBeNull();
    expect(media.isConnected).toBe(false);
    player.src = "https://example.com/waveform-recovery.mp3?mediaTicket=recovered";
    await player.updateComplete;
    await waitForSolid(() =>
      expect(source(player)).toBe(
        "https://example.com/waveform-recovery.mp3?mediaTicket=recovered",
      ),
    );
    expect(player.querySelector("audio")).not.toBe(media);
    expect(player.querySelector("audio")?.isConnected).toBe(true);
    expect(card(player, "--compact")).toBeNull();
  });

  it("discards waveform peaks when decoded duration exceeds the server gate by 20 percent", async () => {
    const decodeAudioData = vi.fn(async () => decodedAudio(121));
    const AudioContextMock = vi.fn(function (options?: AudioContextOptions) {
      expect(options?.sampleRate).toBe(16_000);
      return { decodeAudioData, close: vi.fn(async () => undefined) };
    });
    vi.stubGlobal("AudioContext", AudioContextMock);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => audioResponse()),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:duration-mismatch");
    const player = await createPlayer("duration-mismatch");
    player.serverDurationMs = 100_000;
    const media = audio(player);
    setMediaNumber(media, "duration", 100);
    media.dispatchEvent(new Event("loadedmetadata"));
    await player.updateComplete;
    mockPlay(media);
    control(player, "toggle").click();
    await waitForSolid(() => expect(media.getAttribute("src")).toBe("blob:duration-mismatch"));
    expect(decodeAudioData).toHaveBeenCalledOnce();
    expect(waveformElement(player)).toBeNull();
    expect(times(player)).toEqual(["0:00 / 1:40"]);
  });

  it("does not buffer or cache a chunked waveform response above 8 MiB", async () => {
    const decodeAudioData = stubAudioContext();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(CHAT_AUDIO_WAVEFORM_MAX_BYTES + 1));
          controller.close();
        },
      }),
      { status: 200, headers: { "Content-Type": "audio/mpeg" } },
    );
    const fetchMock = vi.fn<typeof fetch>(async () => response);
    vi.stubGlobal("fetch", fetchMock);
    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    const player = await createPlayer("oversized-waveform");
    player.serverDurationMs = 4_000;
    const media = audio(player);
    const play = mockPlay(media);
    control(player, "toggle").click();
    expect(play).toHaveBeenCalledOnce();
    await waitForSolid(() => expect(fetchMock).toHaveBeenCalledOnce());
    await waitForSolid(() => expect(response.body?.locked).toBe(false));
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(decodeAudioData).not.toHaveBeenCalled();
    expect(waveformElement(player)).toBeNull();
    expect(media.getAttribute("src")).toBe("https://example.com/oversized-waveform.mp3");
  });

  it("transfers Blob ownership when AudioContext construction fails", async () => {
    const FailingAudioContext = vi.fn(function () {
      throw new Error("audio context limit reached");
    });
    vi.stubGlobal("AudioContext", FailingAudioContext);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => audioResponse()),
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:context-fallback");
    const player = await createPlayer("context-fallback");
    player.serverDurationMs = 4_000;
    const media = audio(player);
    const { play } = mockPlayback(media);
    control(player, "toggle").click();
    await waitForSolid(() => expect(FailingAudioContext).toHaveBeenCalledOnce());
    await Promise.resolve();
    flush();
    media.pause();
    control(player, "toggle").click();
    expect(play).toHaveBeenCalledTimes(2);
    expect(media.getAttribute("src")).toBe("blob:context-fallback");
  });

  it("cancels the old source when identity changes during rendition preparation", async () => {
    const { fetchMock, resolve: resolveFetch } = pendingFetch();
    const player = await createPlayer("identity-before");
    const media = audio(player);
    const { play, pause } = mockActivePlayback(media);
    player.src = "/__openclaw__/assistant-media?source=after.caf&mediaTicket=ticket";
    player.sourceIdentity = "media://identity-after";
    player.label = "after.caf";
    player.playback = "transcode";
    player.authToken = "new-principal";
    expect(pause).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    await waitForSolid(() => expect(player.textContent).toContain("Preparing playback…"));
    expect(pause).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/__openclaw__/assistant-media?source=after.caf&mediaTicket=ticket&playback=1",
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer new-principal",
    );
    expect(media.hasAttribute("src")).toBe(false);
    resolveFetch?.(new Response(null, { status: 200 }));
    await waitForSolid(() => expect(media.getAttribute("src")).toContain("playback=1"));
    media.dispatchEvent(new Event("loadedmetadata"));
    expect(play).not.toHaveBeenCalled();
  });

  it("does not auto-resume a refreshed source after disconnecting before metadata", async () => {
    const player = await createPlayer("disconnect-resume");
    const media = audio(player);
    const { play, pause } = mockActivePlayback(media);
    player.src = "https://example.com/disconnect-resume-fresh.mp3";
    await player.updateComplete;
    media.dispatchEvent(new Event("error"));
    player.remove();
    await Promise.resolve();
    flush();
    expect(pause).toHaveBeenCalledOnce();
    mountSolid(() => player);
    media.currentTime = 0;
    media.dispatchEvent(new Event("loadedmetadata"));
    expect(play).not.toHaveBeenCalled();
  });

  it("does not auto-resume after another player supersedes the pending restore", async () => {
    const first = await createPlayer("superseded-resume");
    const firstMedia = audio(first);
    const { play: playFirst, pause: pauseFirst } = mockActivePlayback(firstMedia);
    firstMedia.dispatchEvent(new Event("play"));
    first.src = "https://example.com/superseded-resume-fresh.mp3";
    await first.updateComplete;
    firstMedia.dispatchEvent(new Event("error"));
    const second = await createPlayer("superseding-player");
    audio(second).dispatchEvent(new Event("play"));
    expect(pauseFirst).toHaveBeenCalledOnce();
    second.remove();
    firstMedia.currentTime = 0;
    firstMedia.dispatchEvent(new Event("loadedmetadata"));
    expect(playFirst).not.toHaveBeenCalled();
  });
});
