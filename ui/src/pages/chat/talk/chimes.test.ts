import { expect, it, vi } from "vitest";
import { prepareTalkChimes, TalkChimes } from "./chimes.ts";

const allCues = { wake: true, bye: true, follow: true };

it("plays wake once and bye once on clean stop", () => {
  const play = vi.fn();
  const cues = new TalkChimes(allCues, false, play, vi.fn());
  cues.status("connecting", true);
  cues.status("listening", true);
  cues.status("thinking", true);
  cues.status("connecting", true);
  cues.status("listening", true);
  cues.end(true);
  cues.status("idle", true);
  expect(play.mock.calls).toEqual([["wake"], ["bye"]]);
});

it("does not sound on failed startup or an unready stop", () => {
  const play = vi.fn();
  const cues = new TalkChimes(allCues, false, play, vi.fn());
  cues.status("error", true);
  cues.status("listening", true);
  cues.end(true);
  new TalkChimes(allCues, false, play, vi.fn()).end(true);
  expect(play).not.toHaveBeenCalled();
});

it.each(["error", "replacement"] as const)("cancels instead of playing bye on %s", (reason) => {
  const play = vi.fn();
  const cancel = vi.fn();
  const cues = new TalkChimes(allCues, false, play, cancel);
  cues.status("listening", true);
  if (reason === "error") {
    cues.status("error", true);
  } else {
    cues.end(false);
  }
  cues.status("idle", true);
  expect(play.mock.calls).toEqual([["wake"]]);
  expect(cancel).toHaveBeenCalledOnce();
});

it("keeps a ready replacement silent until clean end", () => {
  const play = vi.fn();
  const cues = new TalkChimes(allCues, true, play, vi.fn());
  cues.status("listening", true);
  cues.status("idle", true);
  expect(play.mock.calls).toEqual([["bye"]]);
});

it("suppresses wake when microphone echo cancellation is not active", () => {
  const play = vi.fn();
  const cues = new TalkChimes(allCues, false, play, vi.fn());
  cues.status("listening", false);
  cues.status("listening", true);
  expect(play).not.toHaveBeenCalled();
  cues.end(true);
  expect(play.mock.calls).toEqual([["bye"]]);
});

it("plays follow only when split capture reports a resumed reply, never on realtime statuses or after Stop", () => {
  const play = vi.fn();
  const cues = new TalkChimes({ wake: false, bye: false, follow: true }, false, play, vi.fn());
  cues.status("listening", true);
  cues.status("thinking", true);
  cues.status("listening", true);
  expect(play).not.toHaveBeenCalled();
  cues.resumedSplitCapture(true);
  cues.resumedSplitCapture(true);
  cues.end(true);
  cues.resumedSplitCapture(true);
  expect(play.mock.calls).toEqual([["follow"], ["follow"]]);
});

it("retries a failed cue download on the next Talk call", async () => {
  const start = vi.fn();
  const fetchCue = vi.fn(async (url: string) => ({
    ok: !url.includes("chime_wake") || fetchCue.mock.calls.length > 1,
    arrayBuffer: async () => new ArrayBuffer(0),
  }));
  vi.stubGlobal("fetch", fetchCue);
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      resume = async () => {};
      decodeAudioData = async () => ({});
      createBufferSource = () => ({
        addEventListener: vi.fn(),
        connect: vi.fn(),
        start,
        stop: vi.fn(),
      });
    },
  );
  try {
    prepareTalkChimes();
    new TalkChimes(allCues, false).status("listening", true);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(start).not.toHaveBeenCalled();

    prepareTalkChimes();
    new TalkChimes(allCues, false).status("listening", true);
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    expect(fetchCue).toHaveBeenCalledTimes(4);
  } finally {
    vi.unstubAllGlobals();
  }
});
