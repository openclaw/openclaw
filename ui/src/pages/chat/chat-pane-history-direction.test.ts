/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import "./chat-pane.tsx";
import { loadChatHistory } from "./chat-history.ts";
import {
  expectNativeHistoryRange,
  transcriptScrollFact,
} from "./chat-pane-history.test-support.ts";
import { residentPane } from "./chat-pane-resident.test-support.ts";

async function directionalHistoryPane(olderPages = 0) {
  const fixture = residentPane();
  const { pane, state } = fixture;
  await loadChatHistory(state, { deferBranches: true });
  for (let page = 0; page < olderPages; page++) {
    expect(await pane.loadOlderMessages(false)).toBe(true);
  }
  const thread = pane.transcript.scrollElement!;
  const loads = vi.spyOn(pane, "loadOlderMessages");
  const scroll = () => pane.handleTranscriptScroll(transcriptScrollFact(pane, thread, -20));
  const evaluate = () => pane.evaluateHistoryEdge();
  const joinOlder = async () => {
    const call = loads.mock.results.at(-1);
    if (call?.type === "return") {
      await call.value;
    }
  };
  return { ...fixture, thread, loads, scroll, evaluate, joinOlder };
}

it("does not carry exhausted upward intent into a newer admission that reopens older history", async () => {
  const { pane, state, thread, requests, loads, scroll, evaluate, joinOlder } =
    await directionalHistoryPane(7);
  expectNativeHistoryRange(state.chatMessages, 1, 400);
  expect(state.chatHistoryPagination.hasMore).toBe(false);
  thread.scrollTop = 80;
  const before = requests.length;
  scroll();
  expect(requests).toHaveLength(before);
  expect(await pane.loadNewerMessages()).toBe(true);
  expect(state.chatHistoryPagination.hasMore).toBe(true);
  const admitted = state.chatMessages;
  const afterNewer = requests.length;
  evaluate();
  await joinOlder();
  expect(loads).not.toHaveBeenCalled();
  expect(requests).toHaveLength(afterNewer);
  expect(state.chatMessages).toBe(admitted);

  const maintenance = vi.spyOn(pane.transcript, "isMaintenanceScroll", "get").mockReturnValue(true);
  thread.scrollTop = 60;
  scroll();
  expect(pane.historyReaderIntent).toBe(false);
  expect(loads).not.toHaveBeenCalled();
  maintenance.mockReturnValue(false);
  thread.scrollTop = 40;
  scroll();
  await joinOlder();
  expect(loads).toHaveBeenCalledExactlyOnceWith(true);
  expect(requests[afterNewer]?.cursor).toBe("before-241");
});

it("retires an older arm before queued edge evaluations after accepted newer navigation", async () => {
  const { pane, thread, requests, holdNextCursor, loads, scroll, evaluate, joinOlder } =
    await directionalHistoryPane(6);
  thread.scrollTop = 1_300;
  scroll();
  expect(pane.historyReaderIntent).toBe(true);
  const before = requests.length;
  const release = holdNextCursor();
  const newer = pane.loadNewerMessages();
  try {
    expect(requests).toHaveLength(before + 1);
    thread.scrollTop = 80;
    evaluate();
    expect(loads).not.toHaveBeenCalled();
  } finally {
    release();
    await newer;
  }
  const afterNewer = requests.length;
  evaluate();
  await joinOlder();
  expect(loads).not.toHaveBeenCalled();
  expect(requests).toHaveLength(afterNewer);
});

it("preserves an older arm when newer navigation is declined", async () => {
  const { pane, thread, loads, scroll, evaluate, joinOlder } = await directionalHistoryPane();
  thread.scrollTop = 1_300;
  scroll();
  expect(pane.historyReaderIntent).toBe(true);
  expect(await pane.loadNewerMessages()).toBe(false);
  expect(pane.historyReaderIntent).toBe(true);
  thread.scrollTop = 80;
  evaluate();
  await joinOlder();
  expect(loads).toHaveBeenCalledExactlyOnceWith(true);
});

it("preserves an older arm across hide and reveal without loading while hidden", async () => {
  const { pane, thread, loads, scroll, evaluate, joinOlder } = await directionalHistoryPane();
  thread.scrollTop = 1_300;
  scroll();
  expect(pane.historyReaderIntent).toBe(true);
  pane.presented = false;
  thread.scrollTop = 80;
  evaluate();
  expect(loads).not.toHaveBeenCalled();
  expect(pane.historyReaderIntent).toBe(true);
  pane.presented = true;
  evaluate();
  await joinOlder();
  expect(loads).toHaveBeenCalledExactlyOnceWith(true);
});

it("does not autofill older history during or after accepted newer navigation", async () => {
  const { pane, thread, requests, holdNextCursor, loads, evaluate, joinOlder } =
    await directionalHistoryPane(6);
  Object.defineProperty(thread, "scrollHeight", { configurable: true, value: 400 });
  expect(pane.historyReaderIntent).toBe(false);
  const before = requests.length;
  const release = holdNextCursor();
  const newer = pane.loadNewerMessages();
  let admitted: boolean;
  try {
    evaluate();
    evaluate();
    expect(loads).not.toHaveBeenCalled();
    expect(requests).toHaveLength(before + 1);
  } finally {
    release();
    admitted = await newer;
    await joinOlder();
  }
  expect(admitted).toBe(true);
  evaluate();
  expect(loads).not.toHaveBeenCalled();
  const event = new WheelEvent("wheel", { deltaY: -100 });
  Object.defineProperty(event, "currentTarget", { value: thread });
  pane.handleTranscriptHistoryIntent(event);
  await joinOlder();
  expect(loads).toHaveBeenCalledExactlyOnceWith(true);
});
