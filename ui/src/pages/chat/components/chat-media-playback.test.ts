import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendChatMediaPlaybackParam, waitForChatMediaPlayback } from "./chat-media-playback.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("chat media playback renditions", () => {
  it("appends playback=1 without dropping assistant or managed media tickets", () => {
    expect(
      appendChatMediaPlaybackParam(
        "/__openclaw__/assistant-media?source=%2Ftmp%2Fvoice.caf&mediaTicket=assistant",
      ),
    ).toBe(
      "/__openclaw__/assistant-media?source=%2Ftmp%2Fvoice.caf&mediaTicket=assistant&playback=1",
    );
    expect(
      appendChatMediaPlaybackParam(
        "/api/chat/media/outgoing/agent%3Amain%3Amain/audio/full?mediaTicket=managed",
      ),
    ).toBe(
      "/api/chat/media/outgoing/agent%3Amain%3Amain/audio/full?mediaTicket=managed&playback=1",
    );
    expect(appendChatMediaPlaybackParam("media/clip.avi?mediaTicket=relative#preview")).toBe(
      "media/clip.avi?mediaTicket=relative&playback=1#preview",
    );
    expect(appendChatMediaPlaybackParam("//cdn.example/clip.avi?mediaTicket=cdn")).toBe(
      "//cdn.example/clip.avi?mediaTicket=cdn&playback=1",
    );
  });

  it("fails a stalled readiness request at its request deadline", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => await new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const pending = waitForChatMediaPlayback({
      source: "/media?playback=1",
      signal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toBe("unavailable");
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it("clamps a retry sleep to the remaining overall deadline", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      vi.setSystemTime(new Date(119_000));
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const pending = waitForChatMediaPlayback({
      source: "/media?playback=1",
      signal: new AbortController().signal,
    });
    let settled = false;
    void pending.then(() => (settled = true));

    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe("unavailable");
    expect(Date.now()).toBe(120_000);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
