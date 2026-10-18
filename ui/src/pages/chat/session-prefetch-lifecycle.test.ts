/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { resolveChatSnapshotKey, type ChatSessionSnapshot } from "./session-message-cache.ts";
import {
  createSessionPrefetchFixture,
  prefetchHistoryRequest as historyRequest,
  advanceSessionPrefetch as advance,
  prefetchState,
  PREFETCH_TEST_NOW as NOW,
  prefetchSnapshotHost as snapshotHost,
  prefetchSessionRow as row,
  prefetchHistoryResult as historyResult,
  prefetchSessionKeyFromCall as sessionKeyFromCall,
  settleSessionPrefetch as settlePromises,
} from "./session-prefetch.test-support.ts";

let fixture: ReturnType<typeof createSessionPrefetchFixture>;
let shell: HTMLElement;
let request: ReturnType<typeof historyRequest>;
let intend: ReturnType<typeof createSessionPrefetchFixture>["intend"];
let updatePrefetch: ReturnType<typeof createSessionPrefetchFixture>["updatePrefetch"];
beforeEach(() => {
  fixture = createSessionPrefetchFixture();
  ({ shell, updatePrefetch, intend } = fixture);
  request = historyRequest();
});
afterEach(async () => fixture.dispose());

function mountPane(
  parent: Element = shell,
  sessionKey = "agent:main:main",
  transcriptLoading = false,
) {
  const pane = Object.assign(document.createElement("openclaw-chat-pane"), {
    sessionKey,
    transcriptLoading,
  });
  parent.append(pane);
  if (parent === shell) {
    updatePrefetch(
      prefetchState(request, [row(sessionKey, NOW), row("agent:main:recent", NOW - 1)]),
    );
  }
  return pane;
}

it.each(["pointerover", "focusin"] as const)(
  "observes sidebar %s intent after a detached host joins the shell",
  async (eventType) => {
    const intended = "agent:main:warm-after-attachment";
    fixture.unmountPrefetch();
    fixture.host.remove();
    fixture.mountPrefetch();
    shell.append(fixture.host);
    updatePrefetch(prefetchState(request, [row(intended, NOW - 1)]));
    await advance();
    expect(request).not.toHaveBeenCalled();
    const sidebar = document.createElement("openclaw-app-sidebar");
    shell.append(sidebar);
    intend(intended, sidebar, eventType);
    await advance();
    expect(request.mock.calls.map(sessionKeyFromCall)).toEqual([intended]);
    expect(request.mock.calls.map(([method]) => method)).toEqual(["chat.history"]);
  },
);

it.each(["stored read", "cursor reset"])(
  "rechecks dashboard intent after %s before another history request",
  async (phase) => {
    const dashboard = "agent:main:dashboard";
    const first = "agent:main:first";
    const next = "agent:main:next";
    const stored: ChatSessionSnapshot = {
      deltaCursor: "stored-cursor",
      messages: [],
      pagination: { hasMore: false, completeSnapshot: true },
      sessionId: "stored-first",
    };
    fixture.store.write(resolveChatSnapshotKey(snapshotHost, { sessionKey: first }), stored);
    await fixture.store.flush();
    fixture.cache.clear();
    const read = createDeferred<ChatSessionSnapshot | null>();
    const reset = createDeferred<{ kind: "reset"; reason: string }>();
    if (phase === "stored read") {
      vi.spyOn(fixture.store, "read").mockReturnValueOnce(read.promise);
    }
    const cursorRequest = vi.fn(async (_method: string, params: unknown) =>
      (params as { sessionKey: string }).sessionKey === first ? reset.promise : historyResult(next),
    );
    updatePrefetch(
      prefetchState(cursorRequest, [row(first, NOW + 1), row(next, NOW)], {
        openSessionKeys: [dashboard],
        hiddenConversationSessionKeys: [dashboard],
      }),
    );
    const target = intend(first);
    await advance();
    expect(cursorRequest.mock.calls.map(sessionKeyFromCall)).toEqual(
      phase === "cursor reset" ? [first] : [],
    );
    target.dataset.sessionKey = next;
    target.dispatchEvent(new Event("pointerover", { bubbles: true }));
    if (phase === "stored read") {
      read.resolve(stored);
    } else {
      reset.resolve({ kind: "reset", reason: "stale-cursor" });
    }
    await settlePromises();
    await advance();
    expect(cursorRequest.mock.calls.map(sessionKeyFromCall)).toEqual(
      phase === "cursor reset" ? [first, next] : [next],
    );
  },
);

it("excludes the Home pane beside the page without borrowing another app's panes", async () => {
  const home = mountPane();
  const otherShell = document.createElement("openclaw-app-shell");
  mountPane(otherShell, "agent:main:recent", true);
  document.body.append(otherShell);
  onTestFinished(() => otherShell.remove());
  intend(home.sessionKey);
  await advance();
  expect(request).not.toHaveBeenCalled();
  intend("agent:main:recent");
  await advance();
  expect(request.mock.calls.map(sessionKeyFromCall)).toEqual(["agent:main:recent"]);
});

it.each(["commit", "remove"])(
  "waits for the sibling Home transcript and resumes on %s",
  async (completion) => {
    const home = mountPane();
    intend("agent:main:recent");
    // Home hydrates in its own update, without re-rendering the chat page.
    home.transcriptLoading = true;
    home.dispatchEvent(new Event("openclaw-chat-transcript-loading-changed", { bubbles: true }));
    await advance();
    expect(request).not.toHaveBeenCalled();
    if (completion === "commit") {
      home.transcriptLoading = false;
      home.dispatchEvent(new Event("openclaw-chat-transcript-loading-changed", { bubbles: true }));
    } else {
      home.remove();
      shell.dispatchEvent(new Event("openclaw-chat-pane-lifecycle-changed"));
    }
    await advance();
    expect(request.mock.calls.map(sessionKeyFromCall)).toEqual(["agent:main:recent"]);
  },
);
