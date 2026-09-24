/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MentionInboxItem } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred as deferred } from "../../../test/helpers/promise.js";
import type { ApplicationContext } from "../app/context.ts";
import type { MentionsCapability } from "../app/mentions.ts";
import {
  CHAT_SPLIT_NARROW_MEDIA_QUERY,
  type ChatSplitLayout,
} from "../pages/chat/split-layout-types.ts";
import { createApplicationContextProvider } from "../test-helpers/application-context.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import "./mention-notifications.ts";

type NotificationView = typeof import("./mention-notification-view.ts");
type NotificationElement = HTMLElement & {
  sessionKey: string | null;
  splitLayout?: ChatSplitLayout;
  updateComplete: Promise<boolean>;
};

function mention(id: string): MentionInboxItem {
  return {
    id,
    senderProfileId: "alice",
    senderLabel: "Alice",
    sessionKey: `agent:writer:${id}`,
    agentId: "writer",
    sessionTitle: id,
    messageId: id,
    createdAt: 1_000,
    expiresAt: 10_000,
  };
}

function source() {
  const stateListeners = new Set<() => void>();
  const arrivals = new Set<(items: readonly MentionInboxItem[]) => void>();
  const mentions: MentionsCapability = {
    snapshot: { phase: "ready", items: [mention("seed")], dismissing: [], error: null },
    refresh: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => undefined),
    dispose: vi.fn(),
    subscribe(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    subscribeArrivals(listener) {
      arrivals.add(listener);
      return () => arrivals.delete(listener);
    },
  };
  const activate = vi.fn();
  const context = {
    sidebarAttention: { getMentions: () => mentions, activate },
  } as unknown as ApplicationContext;
  return {
    context,
    activate,
    mentions,
    publish(items: MentionInboxItem[], newItems: MentionInboxItem[] = []) {
      mentions.snapshot.items = items;
      for (const listener of stateListeners) {
        listener();
      }
      for (const listener of arrivals) {
        listener(newItems);
      }
    },
  };
}

async function mount(context: ApplicationContext) {
  const provider = createApplicationContextProvider(context);
  const element = document.createElement("openclaw-mention-notifications") as NotificationElement;
  provider.append(element);
  document.body.append(provider);
  await element.updateComplete;
  return { provider, element };
}

describe("lazy mention notification lifetime", () => {
  let loading: ReturnType<typeof deferred<NotificationView>>;
  let loadStarted: ReturnType<typeof deferred<void>>;
  let view: NotificationView;
  let load: ReturnType<typeof vi.fn<() => Promise<NotificationView>>>;
  let setViewport: (width: number) => void;
  let media: MediaQueryList;
  let removeMediaListener: ReturnType<
    typeof vi.fn<typeof EventTarget.prototype.removeEventListener>
  >;

  beforeEach(() => {
    let width = 1100;
    const events = new EventTarget();
    removeMediaListener = vi.fn(events.removeEventListener.bind(events));
    media = {
      get matches() {
        return width < 1100;
      },
      media: CHAT_SPLIT_NARROW_MEDIA_QUERY,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(events.addEventListener.bind(events)),
      removeEventListener: removeMediaListener,
      dispatchEvent: events.dispatchEvent.bind(events),
    };
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => media),
    );
    setViewport = (next) => {
      const wasNarrow = media.matches;
      width = next;
      if (media.matches !== wasNarrow) {
        media.dispatchEvent(new Event("change"));
      }
    };
    loading = deferred<NotificationView>();
    loadStarted = deferred();
    view = { showMentionNotification: vi.fn() };
    load = vi.fn(() => {
      loadStarted.resolve();
      return loading.promise;
    });
    vi.doMock("./mention-notification-view.ts", load);
  });

  afterEach(async () => {
    document.body.replaceChildren();
    loading.resolve(view);
    await vi.dynamicImportSettled();
    vi.doUnmock("./mention-notification-view.ts");
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("tracks 1099/1100 split visibility without shell rerenders and cancels queued and active work", async () => {
    const owner = source();
    const { provider, element } = await mount(owner.context);
    const active = mention("active");
    const other = mention("other");
    element.sessionKey = active.sessionKey;
    element.splitLayout = {
      activePaneId: "active",
      columnWeights: [0.5, 0.5],
      columns: [
        { id: "a", paneWeights: [1], panes: [{ id: "active", sessionKey: active.sessionKey }] },
        { id: "b", paneWeights: [1], panes: [{ id: "other", sessionKey: other.sessionKey }] },
      ],
    };
    await element.updateComplete;
    owner.publish([other], [other]);
    expect(load).not.toHaveBeenCalled();
    setViewport(1099);
    await element.updateComplete;
    const queued = { ...other, id: "queued" };
    owner.publish([queued], [queued]);
    await loadStarted.promise;
    expect(load).toHaveBeenCalledTimes(1);
    setViewport(1100);
    await element.updateComplete;
    loading.resolve(view);
    await vi.dynamicImportSettled();
    expect(view.showMentionNotification).not.toHaveBeenCalled();

    setViewport(1099);
    await element.updateComplete;
    const shown = { ...other, id: "shown" };
    owner.publish([shown], [shown]);
    await vi.dynamicImportSettled();
    expect(view.showMentionNotification).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(view.showMentionNotification).mock.calls[0]![2];
    expect(signal.aborted).toBe(false);
    setViewport(1100);
    await element.updateComplete;
    expect(signal.aborted).toBe(true);
    expect(owner.mentions.dismiss).not.toHaveBeenCalled();

    // Settings has no visible chat even when a retained split layout exists.
    element.sessionKey = null;
    await element.updateComplete;
    const settings = { ...other, id: "settings" };
    owner.publish([settings], [settings]);
    await vi.dynamicImportSettled();
    expect(view.showMentionNotification).toHaveBeenCalledTimes(2);
    const settingsSignal = vi.mocked(view.showMentionNotification).mock.calls[1]![2];
    setViewport(1099);
    setViewport(1100);
    await element.updateComplete;
    expect(settingsSignal.aborted).toBe(false);

    element.remove();
    expect(settingsSignal.aborted).toBe(true);
    expect(removeMediaListener).toHaveBeenCalledWith("change", expect.any(Function));
    setViewport(1099);
    provider.append(element);
    element.sessionKey = active.sessionKey;
    await element.updateComplete;
    const reconnected = { ...other, id: "reconnected" };
    owner.publish([reconnected], [reconnected]);
    await vi.dynamicImportSettled();
    expect(view.showMentionNotification).toHaveBeenCalledTimes(3);
    expect(globalThis.matchMedia).toHaveBeenCalledWith(CHAT_SPLIT_NARROW_MEDIA_QUERY);
  });

  it("loads only on a non-visible arrival, retires stale work during loading, and preserves FIFO", async () => {
    const owner = source();
    const { element } = await mount(owner.context);
    const visible = mention("visible");
    element.sessionKey = visible.sessionKey;
    await element.updateComplete;
    owner.publish([visible], [visible]);
    expect(owner.activate).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();

    const removed = mention("removed");
    const opened = mention("opened");
    const first = mention("first");
    const second = mention("second");
    owner.publish([removed, opened, first], [removed, opened, first]);
    await waitForFast(() => expect(load).toHaveBeenCalledTimes(1));
    owner.publish([opened, first, second], [second]);
    element.sessionKey = opened.sessionKey;
    await element.updateComplete;
    loading.resolve(view);
    await vi.dynamicImportSettled();
    expect(vi.mocked(view.showMentionNotification).mock.calls.map(([item]) => item.id)).toEqual([
      "first",
      "second",
    ]);
    const firstSignal = vi.mocked(view.showMentionNotification).mock.calls[0]![2];
    element.sessionKey = first.sessionKey;
    await element.updateComplete;
    expect(firstSignal.aborted).toBe(true);
    expect(owner.mentions.dismiss).not.toHaveBeenCalled();
  });

  it.each(["disconnect", "replace"])(
    "rejects late presentation after %s without deleting a new owner's entry",
    async (boundary) => {
      const oldOwner = source();
      const { provider, element } = await mount(oldOwner.context);
      const item = mention("same-id");
      oldOwner.publish([item], [item]);
      await waitForFast(() => expect(load).toHaveBeenCalledTimes(1));
      const nextOwner = source();
      if (boundary === "disconnect") {
        element.remove();
        provider.setContext(nextOwner.context);
        provider.append(element);
      } else {
        provider.setContext(nextOwner.context);
      }
      await element.updateComplete;
      nextOwner.publish([item], [item]);
      loading.resolve(view);
      await vi.dynamicImportSettled();
      expect(view.showMentionNotification).toHaveBeenCalledTimes(1);
      expect(view.showMentionNotification).toHaveBeenCalledWith(
        item,
        nextOwner.context,
        expect.any(AbortSignal),
        expect.any(Function),
      );
      const signal = vi.mocked(view.showMentionNotification).mock.calls[0]![2];
      expect(signal.aborted).toBe(false);
      nextOwner.publish([]);
      expect(signal.aborted).toBe(true);
      expect(oldOwner.mentions.dispose).not.toHaveBeenCalled();
    },
  );

  it("forgets failed imports so later arrivals can present without dismissing the Inbox", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const owner = source();
    await mount(owner.context);
    const item = mention("retry");
    owner.publish([item], [item]);
    await waitForFast(() => expect(load).toHaveBeenCalledTimes(1));
    loading.reject(new Error("chunk unavailable"));
    await vi.dynamicImportSettled();
    expect(warning).toHaveBeenCalledTimes(1);
    expect(view.showMentionNotification).not.toHaveBeenCalled();
    expect(owner.mentions.snapshot.items).toEqual([item]);
    expect(owner.mentions.dismiss).not.toHaveBeenCalled();

    vi.doMock("./mention-notification-view.ts", () => view);
    // A failed entry no longer occupies the transient pending set.
    owner.publish([item], [item]);
    await vi.dynamicImportSettled();
    expect(view.showMentionNotification).toHaveBeenCalledTimes(1);
  });
});
