/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import "./chat-pane.tsx";
import { loadChatHistory } from "./chat-history.ts";
import {
  appendSentinel,
  installHistoryObserver,
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
  appendSentinel(thread, pane);
  const observer = installHistoryObserver(false);
  const loads = vi.spyOn(pane, "loadOlderMessages");
  const scroll = () => pane.handleTranscriptScroll(transcriptScrollFact(pane, thread, -20));
  const intersect = (index = observer.construct.mock.calls.length - 1) => {
    const [notify, current] = observer.construct.mock.calls[index]!;
    notify([{ isIntersecting: true } as IntersectionObserverEntry], current);
  };
  const joinOlder = async () => {
    const call = loads.mock.results.at(-1);
    if (call?.type === "return") {
      await call.value;
    }
  };
  return { ...fixture, thread, observer, loads, scroll, intersect, joinOlder };
}

it("does not carry exhausted upward intent into a newer admission that reopens older history", async () => {
  const { pane, state, thread, requests, observer, loads, scroll, intersect, joinOlder } =
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
  pane.syncHistoryObserver();
  if (observer.construct.mock.calls.length) {
    intersect();
  }
  await joinOlder();
  expect(loads).not.toHaveBeenCalled();
  expect(requests).toHaveLength(afterNewer);
  expect(state.chatMessages).toBe(admitted);

  const maintenance = vi.spyOn(pane.transcript, "isMaintenanceScroll", "get").mockReturnValue(true);
  thread.scrollTop = 60;
  scroll();
  expect(pane.historyObserverArmed).toBe(false);
  expect(loads).not.toHaveBeenCalled();
  maintenance.mockReturnValue(false);
  thread.scrollTop = 40;
  scroll();
  intersect();
  await joinOlder();
  expect(loads).toHaveBeenCalledExactlyOnceWith(true);
  expect(requests[afterNewer]?.cursor).toBe("before-241");
});

it("retires a valid older arm and its queued observer when newer navigation is accepted", async () => {
  const { pane, thread, requests, holdNextCursor, observer, loads, scroll, intersect, joinOlder } =
    await directionalHistoryPane(6);
  thread.scrollTop = 80;
  scroll();
  expect(pane.historyObserverArmed).toBe(true);
  expect(observer.construct).toHaveBeenCalledOnce();
  const before = requests.length;
  const release = holdNextCursor();
  const newer = pane.loadNewerMessages();
  try {
    expect(requests).toHaveLength(before + 1);
    intersect(0);
    expect(loads).not.toHaveBeenCalled();
  } finally {
    release();
    await newer;
  }
  const afterNewer = requests.length;
  pane.syncHistoryObserver();
  intersect();
  await joinOlder();
  expect(loads).not.toHaveBeenCalled();
  expect(requests).toHaveLength(afterNewer);
});

it("preserves a valid older arm when newer navigation is declined", async () => {
  const { pane, thread, observer, loads, scroll, intersect, joinOlder } =
    await directionalHistoryPane();
  thread.scrollTop = 80;
  scroll();
  expect(pane.historyObserverArmed).toBe(true);
  expect(await pane.loadNewerMessages()).toBe(false);
  expect(pane.historyObserverArmed).toBe(true);
  expect(observer.construct).toHaveBeenCalledOnce();
  intersect();
  await joinOlder();
  expect(loads).toHaveBeenCalledExactlyOnceWith(true);
});

it("preserves a valid older arm across hide and reveal without reviving its queued observer", async () => {
  const { pane, thread, observer, loads, scroll, intersect, joinOlder } =
    await directionalHistoryPane();
  thread.scrollTop = 80;
  scroll();
  expect(pane.historyObserverArmed).toBe(true);
  pane.presented = false;
  intersect(0);
  expect(loads).not.toHaveBeenCalled();
  expect(pane.historyObserverArmed).toBe(true);
  pane.presented = true;
  pane.syncHistoryObserver();
  expect(observer.construct).toHaveBeenCalledTimes(2);
  intersect();
  await joinOlder();
  expect(loads).toHaveBeenCalledExactlyOnceWith(true);
});

it("does not autofill older history during or after accepted newer navigation", async () => {
  const { pane, thread, requests, holdNextCursor, observer, loads, intersect, joinOlder } =
    await directionalHistoryPane(6);
  Object.defineProperty(thread, "scrollHeight", { configurable: true, value: 400 });
  pane.syncHistoryObserver();
  expect(observer.construct).toHaveBeenCalledOnce();
  expect(pane.historyObserverArmed).toBe(false);
  const before = requests.length;
  const release = holdNextCursor();
  const newer = pane.loadNewerMessages();
  let admitted: boolean;
  try {
    intersect(0);
    pane.syncHistoryObserver();
    intersect();
    expect(loads).not.toHaveBeenCalled();
    expect(requests).toHaveLength(before + 1);
  } finally {
    release();
    admitted = await newer;
    await joinOlder();
  }
  expect(admitted).toBe(true);
  pane.syncHistoryObserver();
  intersect();
  expect(loads).not.toHaveBeenCalled();
  const event = new WheelEvent("wheel", { deltaY: -100 });
  Object.defineProperty(event, "currentTarget", { value: thread });
  pane.handleTranscriptHistoryIntent(event);
  intersect();
  await joinOlder();
  expect(loads).toHaveBeenCalledExactlyOnceWith(true);
});
