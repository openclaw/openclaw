/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMediaSourceOwner } from "./chat-media-source.ts";

function mockMediaState(
  media: HTMLMediaElement,
  state: { currentTime: number; duration: number; paused: boolean; ended?: boolean },
) {
  let currentTime = state.currentTime;
  let rejected = false;
  Object.defineProperties(media, {
    currentTime: {
      configurable: true,
      get: () => currentTime,
      set: (value: number) => {
        if (rejected) {
          throw new DOMException("media range unavailable", "InvalidStateError");
        }
        currentTime = value;
      },
    },
    duration: { configurable: true, get: () => state.duration },
    paused: { configurable: true, get: () => state.paused },
    ended: { configurable: true, get: () => state.ended === true },
  });
  return {
    setSeekRejected: (value: boolean) => {
      rejected = value;
    },
  };
}

function setup(tag: "audio" | "video" = "audio") {
  const media = document.createElement(tag);
  const controller = new ChatMediaSourceOwner();
  return { media, controller, sync: controller.sync.bind(controller, media) };
}

const response = (status = 200) => new Response(null, { status });

function playback(currentTime = 0, paused = true, duration = 80, tag: "audio" | "video" = "audio") {
  const state = { currentTime, paused, duration, ended: false, error: null as MediaError | null };
  const { media, controller } = setup(tag);
  const clock = mockMediaState(media, state);
  const update = (ticket: string, identity = "/tmp/media") =>
    controller.updateSource(media, `/media?mediaTicket=${ticket}`, identity);
  return { media, controller, clock, update, state };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatMediaSourceOwner", () => {
  it("normalizes and applies native playback immediately", () => {
    const media = document.createElement("audio");
    const controller = new ChatMediaSourceOwner();

    expect(controller.sync(media, "  /media/native.mp3  ", "  media:native  ", "native")).toBe(
      null,
    );

    expect(controller.readiness).toBe("ready");
    expect(controller.readySource).toBe("/media/native.mp3");
    expect(media.getAttribute("src")).toBe("/media/native.mp3");
  });

  it("aborts preparation and starts it again after reconnect", async () => {
    let firstSignal: AbortSignal | undefined;
    const pending = Promise.withResolvers<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce((_source, init) => {
        firstSignal = init?.signal ?? undefined;
        firstSignal?.addEventListener(
          "abort",
          () => pending.reject(new DOMException("disconnected", "AbortError")),
          { once: true },
        );
        return pending.promise;
      })
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetchMock);
    const { media, controller, sync } = setup();
    const source = "/media/voice.caf?mediaTicket=ticket";

    const first = sync(source, "media:voice", "transcode");
    controller.cancel();
    expect(firstSignal?.aborted).toBe(true);
    expect(controller.readiness).toBe("idle");

    const second = sync(source, "media:voice", "transcode");
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(controller.readiness).toBe("ready");
    expect(media.getAttribute("src")).toContain("playback=1");
  });

  it("suppresses a stale completion after the readiness identity changes", async () => {
    const old = Promise.withResolvers<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetchMock);
    const { media, sync } = setup("video");

    const oldRequest = sync(
      "/media/old.avi?mediaTicket=old",
      "media:old",
      "transcode",
      "old-token",
    );
    const newRequest = sync(
      "/media/new.avi?mediaTicket=new",
      "media:new",
      "transcode",
      "new-token",
    );
    await newRequest;
    old.resolve(response());
    await oldRequest;

    expect(media.getAttribute("src")).toContain("mediaTicket=new&playback=1");
  });

  it("keeps a usable same-identity source when a refresh is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response(500)));
    const { media, controller, sync } = setup();
    void sync("/media/voice.mp3?mediaTicket=old", "media:voice", "native");
    expect(controller.handleError(media)).toBe(false);
    void sync("/media/voice.mp3?mediaTicket=old", "media:voice", "native");

    const pending = sync("/media/voice.mp3?mediaTicket=fresh", "media:voice", "transcode");
    expect(controller.readiness).toBe("ready");
    await pending;

    expect(controller.readiness).toBe("ready");
    expect(controller.readySource).toContain("mediaTicket=old");
    expect(media.getAttribute("src")).toContain("mediaTicket=old");
  });

  it("reports an unavailable rendition when there is no usable fallback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response(null, { status: 500 })),
    );
    const media = document.createElement("audio");
    const controller = new ChatMediaSourceOwner();
    void controller.sync(media, "/media/voice.caf?mediaTicket=old", "media:voice", "native");
    expect(controller.handleError(media)).toBe(false);

    await controller.sync(
      media,
      "/media/voice.caf?mediaTicket=refresh",
      "media:voice",
      "transcode",
    );

    expect(controller.readiness).toBe("unavailable");
    expect(controller.readySource).toBe("");
    expect(media.getAttribute("src")).toContain("mediaTicket=old");
  });

  it.each([
    ["authentication", "protected", "principal-b"],
    ["source identity", "replacement", "principal-a"],
  ])("removes the old source when a changed %s is unavailable", async (_, name, authToken) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response(500)));
    const { media, controller, sync } = setup("video");
    void sync("/media/protected.mp4?mediaTicket=old", "media:protected", "native", "principal-a");

    const pending = sync(
      `/media/${name}.caf?mediaTicket=refresh`,
      `media:${name}`,
      "transcode",
      authToken,
    );
    expect(media.hasAttribute("src")).toBe(false);
    await pending;

    expect(controller.readiness).toBe("unavailable");
    expect(media.hasAttribute("src")).toBe(false);
  });

  it.each([
    ["paused error", 0, true, 120, "audio", 42],
    ["playing failed seek", 10, false, 90, "video", 55],
  ] as const)(
    "restores position and playback after a %s applies a queued ticket",
    (_, start, paused, duration, tag, target) => {
      const { media, controller, clock, update } = playback(start, paused, duration, tag);
      const play = vi.spyOn(media, "play").mockResolvedValue(undefined);
      if (!paused) {
        document.body.append(media);
      }
      update("old");
      expect(media.getAttribute("src")).toBe("/media?mediaTicket=old");
      if (paused) {
        media.currentTime = target;
      }
      update("fresh");
      expect(media.getAttribute("src")).toBe("/media?mediaTicket=old");
      if (paused) {
        expect(controller.handleError(media)).toBe(true);
      } else {
        clock.setSeekRejected(true);
        expect(controller.seek(media, target)).toBe(true);
        clock.setSeekRejected(false);
      }
      expect(media.getAttribute("src")).toBe("/media?mediaTicket=fresh");
      if (paused) {
        media.currentTime = 0;
      }
      controller.handleLoadedMetadata(media);
      expect(media.currentTime).toBe(target);
      expect(play).toHaveBeenCalledTimes(paused ? 0 : 1);
      media.remove();
    },
  );

  it("applies a queued ticket once playback is idle at the end", () => {
    const { media, controller, update, state } = playback(80);

    update("old");
    update("fresh");
    state.ended = true;

    expect(controller.handleEnded(media)).toBe(true);
    expect(media.getAttribute("src")).toBe("/media?mediaTicket=fresh");
  });

  it("applies a fresh ticket that arrives after the old source has already failed", () => {
    const { media, controller, update, state } = playback();
    Object.defineProperty(media, "error", { configurable: true, get: () => state.error });

    update("old");
    media.currentTime = 30;
    state.error = { code: 2, message: "ticket expired" } as MediaError;
    update("fresh");

    expect(media.getAttribute("src")).toBe("/media?mediaTicket=fresh");
    media.currentTime = 0;
    state.error = null;
    controller.handleLoadedMetadata(media);
    expect(media.currentTime).toBe(30);
  });

  it("replaces a different attachment immediately instead of treating it as a ticket refresh", () => {
    const { media, update, state } = playback(20, false);
    const pause = vi.spyOn(media, "pause").mockImplementation(() => {
      state.paused = true;
    });

    update("first", "/tmp/first.mp3");
    update("second", "/tmp/second.mp3");

    expect(pause).toHaveBeenCalledOnce();
    expect(media.getAttribute("src")).toBe("/media?mediaTicket=second");
  });
});
