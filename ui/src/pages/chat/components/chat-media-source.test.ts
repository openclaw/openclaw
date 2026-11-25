/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMediaSourceOwner } from "./chat-media-source.ts";

function setup(tag: "audio" | "video" = "audio") {
  const media = document.createElement(tag);
  const controller = new ChatMediaSourceOwner();
  return { media, controller, sync: controller.sync.bind(controller, media) };
}

const response = (status = 200) => new Response(null, { status });

function playback(currentTime = 0, paused = true, duration = 80, tag: "audio" | "video" = "audio") {
  const state = { currentTime, paused, duration, ended: false, error: null as MediaError | null };
  const { media, controller } = setup(tag);
  for (const key of ["duration", "paused", "ended", "error"] as const) {
    Object.defineProperty(media, key, { configurable: true, get: () => state[key] });
  }
  Object.defineProperty(media, "currentTime", {
    configurable: true,
    get: () => state.currentTime,
    set: (value: number) => {
      state.currentTime = value;
    },
  });
  const update = (ticket: string, identity = "/tmp/media") =>
    controller.updateSource(media, `/media?mediaTicket=${ticket}`, identity);
  return { media, controller, update, state };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatMediaSourceOwner", () => {
  it("normalizes and applies native playback immediately", () => {
    const { media, controller, sync } = setup();
    expect(sync("  /media/native.mp3  ", "  media:native  ", "native")).toBeNull();
    expect(controller).toMatchObject({ readiness: "ready", readySource: "/media/native.mp3" });
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

    const prepare = (id: string) =>
      sync(`/media/${id}.avi?mediaTicket=${id}`, `media:${id}`, "transcode", `${id}-token`);
    const oldRequest = prepare("old");
    const newRequest = prepare("new");
    await newRequest;
    old.resolve(response());
    await oldRequest;

    expect(media.getAttribute("src")).toContain("mediaTicket=new&playback=1");
  });

  it.each(["usable", "failed", "authentication", "identity"] as const)(
    "preserves only an authorized usable source after a failed refresh: %s",
    async (kind) => {
      vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response(500)));
      const { media, controller, sync } = setup();
      const boundary = kind === "authentication" || kind === "identity";
      const old = "/media/voice?mediaTicket=old";
      const initial = () => sync(old, "media:voice", "native", "principal-a");
      await initial();
      if (!boundary) {
        expect(controller.handleError(media)).toBe(false);
        if (kind === "usable") {
          await initial();
        }
      }
      const pending = sync(
        "/media/voice?mediaTicket=fresh",
        kind === "identity" ? "media:other" : "media:voice",
        "transcode",
        kind === "authentication" ? "principal-b" : "principal-a",
      );
      if (boundary) {
        expect(media.hasAttribute("src")).toBe(false);
      } else if (kind === "usable") {
        expect(controller.readiness).toBe("ready");
      }
      await pending;
      expect(controller.readiness).toBe(kind === "usable" ? "ready" : "unavailable");
      expect(media.getAttribute("src")).toBe(boundary ? null : old);
      expect(controller.readySource).toBe(kind === "usable" ? old : "");
    },
  );

  it.each([
    ["paused error", 0, true, 120, "audio", 42],
    ["playing failed seek", 10, false, 90, "video", 55],
  ] as const)(
    "restores position and playback after a %s applies a queued ticket",
    (_, start, paused, duration, tag, target) => {
      const { media, controller, update } = playback(start, paused, duration, tag);
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
        vi.spyOn(media, "currentTime", "set").mockImplementationOnce(() => {
          throw new DOMException("media range unavailable", "InvalidStateError");
        });
        expect(controller.seek(media, target)).toBe(true);
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
