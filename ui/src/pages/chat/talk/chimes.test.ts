import { expect, it, vi } from "vitest";
import { TalkChimes } from "./chimes.ts";

it("plays wake once and bye once on clean stop", () => {
  const play = vi.fn();
  const cues = new TalkChimes(false, play, vi.fn());
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
  const cues = new TalkChimes(false, play, vi.fn());
  cues.status("error", true);
  cues.status("listening", true);
  cues.end(true);
  new TalkChimes(false, play, vi.fn()).end(true);
  expect(play).not.toHaveBeenCalled();
});

it.each(["error", "replacement"] as const)("cancels instead of playing bye on %s", (reason) => {
  const play = vi.fn();
  const cancel = vi.fn();
  const cues = new TalkChimes(false, play, cancel);
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
  const cues = new TalkChimes(true, play, vi.fn());
  cues.status("listening", true);
  cues.status("idle", true);
  expect(play.mock.calls).toEqual([["bye"]]);
});

it("suppresses wake when microphone echo cancellation is not active", () => {
  const play = vi.fn();
  const cues = new TalkChimes(false, play, vi.fn());
  cues.status("listening", false);
  cues.status("listening", true);
  expect(play).not.toHaveBeenCalled();
  cues.end(true);
  expect(play.mock.calls).toEqual([["bye"]]);
});
