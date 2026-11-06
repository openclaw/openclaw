// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectGarbageForTest } from "../../../test-helpers/garbage-collection.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { buildChatItems } from "../chat-thread-build.ts";
import { makeMessage } from "../chat-thread.test-support.ts";
import {
  buildCachedChatItems,
  resetChatThreadState,
  retireChatThreadSources,
} from "../chat-thread.ts";
import {
  cacheChatSessionSnapshot,
  createChatWidgetLayout,
  type ChatMessageCache,
} from "../session-message-cache.ts";
import {
  footprintLayout,
  mountedVirtualizer,
  phases,
  scheduledCallbacks,
} from "./chat-transcript-layout.test-support.ts";
import { projectTranscriptChain, projectTranscriptIndex } from "./chat-transcript-message-index.ts";
import { GuardedTranscriptItem } from "./chat-transcript-render-guard.ts";
import { CHAT_TRANSCRIPT_SCROLL_RESTORE_STABLE_FRAMES } from "./chat-transcript-session.ts";
import { ChatSessionVirtualizerHost } from "./chat-transcript-virtualizer-host.ts";
import {
  installTranscriptDomMocks,
  flushDeferredRowPrune,
  resetTranscriptTestDom,
  threadProps,
} from "./chat-transcript.test-support.ts";

function hasLiveTarget(reference: WeakRef<object>): boolean {
  return reference.deref() !== undefined;
}

beforeEach(installTranscriptDomMocks);
afterEach(resetTranscriptTestDom);

describe("transcript layout lifetime", () => {
  it.each(phases)("releases a disconnected virtualizer during its $label", async (phase) => {
    const scheduled = scheduledCallbacks(phase.idle);
    const { layout } = footprintLayout();
    const retire = () => {
      const mounted = mountedVirtualizer(layout);
      layout.persistRows(mounted.instance, false);
      if (phase.advance) {
        scheduled.takeFrame()();
      }
      layout.disconnect();
      mounted.dispose();
      return new WeakRef(mounted.instance);
    };
    const obsolete = retire();
    const control = new WeakRef({ unowned: true });

    await collectGarbageForTest();
    expect(hasLiveTarget(control)).toBe(false);
    expect(hasLiveTarget(obsolete)).toBe(false);
    expect(scheduled.frames.size + scheduled.idleCallbacks.size).toBe(0);
    // The retained layout still owns useful geometry across reconnection.
    expect(layout.rowMinimum(0)).toBe(300);
  });

  it("retains only geometry identities when a rendered host disconnects", async () => {
    scheduledCallbacks(true);
    const host = new ChatSessionVirtualizerHost(() => {});
    const { layout } = footprintLayout();
    host.layout.rowLayout = layout.rowLayout;
    host.layout.rowWidth = 768;
    host.layout.paneWidth = 1100;
    const renderAndDisconnect = () => {
      const message = {
        role: "assistant",
        content: [{ type: "text", text: "obsolete transcript body" }],
        timestamp: 10,
        __openclaw: { id: "retired-row", seq: 1 },
      };
      const props = threadProps("layout-retirement", undefined, [message]);
      const items = buildChatItems(props);
      const chain = projectTranscriptChain(items, {
        sessionKey: props.sessionKey,
        runWorking: false,
        searchActive: false,
      });
      const index = projectTranscriptIndex(chain, new Map(), props);
      const rows = index.rows.filter((row) => row.kind === "item");
      expect(index.rows).toHaveLength(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.revision).toEqual(expect.any(String));
      const content = document.createElement("div");
      content.textContent = "obsolete content row";
      host.render([...rows, { kind: "content", key: "content", content }], () => null, null, false);
      host.disconnect();
      return {
        obsolete: [new WeakRef(message), new WeakRef(items[0]!), new WeakRef(content)],
        geometry: [
          ...rows.map(({ key, revision }) => ({ key, revision })),
          { key: "content", revision: undefined },
        ],
        control: new WeakRef({ unowned: true }),
      };
    };
    const { obsolete, geometry, control } = renderAndDisconnect();
    try {
      await collectGarbageForTest();
      expect(hasLiveTarget(control)).toBe(false);
      expect(obsolete.map(hasLiveTarget)).toEqual([false, false, false]);
      expect(host.layout.rows).toEqual(geometry);
      expect(host.layout.rowMinimum(0)).toBe(300);
    } finally {
      host.dispose();
    }
  });

  it("preserves the rendered root across a same-task host move", async () => {
    scheduledCallbacks(true);
    const host = new ChatSessionVirtualizerHost(() => {});
    const render = () =>
      host.render([{ kind: "item", key: "row", item: "retained row" }], () => null, null, false);
    try {
      host.connect();
      const root = render();
      host.disconnect();
      host.connect();
      await Promise.resolve();
      expect(render()).toBe(root);
    } finally {
      host.dispose();
    }
  });

  it.each([false, true])(
    "releases rendered and prewarmed fragments on the same connected host's window replacement (reader takeover: %s)",
    async (readerTakeover) => {
      const scheduled = scheduledCallbacks(true);
      vi.spyOn(globalThis, "requestAnimationFrame");
      const paneId = `fragment-window-replacement-${readerTakeover}`;
      const container = document.body.appendChild(document.createElement("div"));
      Object.defineProperties(container, {
        clientHeight: { value: 600 },
        offsetHeight: { value: 600 },
        offsetWidth: { value: 800 },
        scrollHeight: {
          get: () => Number.parseFloat(host.contentElement?.style.height ?? "0") || 0,
        },
      });
      container.scrollTo = (options?: ScrollToOptions | number) => {
        if (typeof options === "object") {
          container.scrollTop = Math.max(
            0,
            Math.min(options.top ?? container.scrollTop, container.scrollHeight - 600),
          );
        }
      };
      let current: ReturnType<typeof projectTranscriptIndex> | undefined;
      let sources: ReturnType<typeof makeMessage>[] = [];
      let queued = false;
      let disposed = false;
      const renderRow = (row: NonNullable<typeof current>["rows"][number]) => {
        if (row.kind !== "item") {
          return row.content;
        }
        const item = row.item;
        if (item.kind === "agent-run-frame") {
          return new GuardedTranscriptItem([item], {
            kind: "frame",
            frame: item,
            options: {
              streamOptions: {},
              workPreviews: new Map(),
              renderGroupOptions: () => ({ showReasoning: false }),
              isWorkExpanded: () => false,
              onToggleWork: () => {},
            },
          });
        }
        return item.kind === "group"
          ? new GuardedTranscriptItem([item], {
              kind: "group",
              group: item,
              options: { showReasoning: false },
            })
          : null;
      };
      const draw = () => {
        if (!current || disposed) {
          return undefined;
        }
        host.syncMessageRows(current.messageRowKeysById, current.transcriptMessageKeys);
        const root = host.render(current.rows, renderRow, null, false);
        if (root.parentElement !== container) {
          container.append(root);
        }
        host.update();
        flush();
        return root;
      };
      const host = new ChatSessionVirtualizerHost(
        () => {
          if (!queued) {
            queued = true;
            queueMicrotask(() => {
              queued = false;
              draw();
            });
          }
        },
        0,
        undefined,
        { canFollowEnd: () => false },
      );
      const props = (messages: unknown[]) =>
        threadProps(paneId, "agent:main:fragment-lifetime", messages);
      const project = (messages: unknown[]) => {
        const input = props(messages);
        return projectTranscriptIndex(
          projectTranscriptChain(buildCachedChatItems(input), {
            sessionKey: input.sessionKey,
            runWorking: false,
            searchActive: false,
          }),
          new Map(),
          input,
        );
      };
      const remaining = [
        makeMessage("surviving-bookmark", 1000, { role: "user", runId: "next-run" }),
      ];
      const populate = () => {
        sources = [
          makeMessage("fragment-question", 1, { role: "user" }),
          ...Array.from({ length: 260 }, (_, index) =>
            makeMessage(`retired-fragment-${index}`, index + 2, {
              phase: "commentary",
              content: `**Retired fragment ${readerTakeover} ${index}**`,
            }),
          ),
          makeMessage("fragment-answer", 262, { phase: "final_answer", stopReason: "stop" }),
        ];
        current = project([...sources, ...remaining]);
        const fragments = current.rows.flatMap((row) =>
          row.kind === "item" && row.item.kind === "agent-run-frame" && row.item.fragment
            ? [row.item]
            : [],
        );
        expect(fragments.length).toBeGreaterThan(64);
        expect(current.rows[1]?.retainDom).toBe(true);
        return {
          obsolete: [...sources, ...fragments].map((source) => new WeakRef(source)),
          key: current.messageRowKeysById.get("surviving-bookmark"),
        };
      };
      try {
        host.layout.configureRows(props([]), "gutter", false);
        host.connect();
        const { obsolete, key } = populate();
        const root = draw();
        await waitForSolid(() =>
          expect(container.querySelector('[data-index="1"] .chat-bubble')).not.toBeNull(),
        );
        const removed = new WeakRef(container.querySelector('[data-index="1"]')!);
        await waitForSolid(() => expect(host.renderer.prewarmRow(64, "fragment")).toBe(true));
        // Retire source memo ownership before admitting the next window; keep the
        // live renderer/prewarmer and its bounded shared Markdown cache intact.
        retireChatThreadSources(paneId, sources);
        sources = [];
        current = project(remaining);
        expect(current.messageRowKeysById.get("surviving-bookmark")).toBe(key);
        expect(draw()).toBe(root);
        await waitForSolid(() => {
          expect(container.querySelectorAll(".chat-bubble")).toHaveLength(1);
          expect(container.textContent).toContain("surviving-bookmark");
        });
        expect(host.connected).toBe(true);
        expect(host.revealMessage("retired-fragment-0")).toBe(false);
        expect(host.revealMessage("surviving-bookmark")).toBe(true);
        await waitForSolid(() =>
          expect(container.querySelector(".chat-bubble--reply-target")).not.toBeNull(),
        );
        // The legitimate survivor reveal can remain active or yield to reader
        // input; neither lifetime may retain the retired source window.
        if (readerTakeover) {
          host.scrollElement!.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
        }
        // Native row refs and reveal enqueue read/apply and range commits. Drive
        // their existing bounded restoration frames, without running idle warming.
        for (
          let frame = 0;
          frame <= CHAT_TRANSCRIPT_SCROLL_RESTORE_STABLE_FRAMES && scheduled.frames.size;
          frame++
        ) {
          scheduled.takeFrame()();
          flush();
          await flushDeferredRowPrune();
        }
        if (readerTakeover) {
          expect(host.offsetState.scrollCommand).toBeNull();
        } else {
          expect(host.offsetState.scrollCommand?.target).toBe("index");
        }
        expect(host.isPositionSettled).toBe(true);
        // Geometry spies record their receivers, including retired DOM. Discard
        // only fixture call histories before checking live product ownership.
        for (const mock of [
          Reflect.get(
            Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")!,
            "get",
          ),
          Reflect.get(Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight")!, "get"),
          Reflect.get(Element.prototype, "getBoundingClientRect"),
          Reflect.get(Element.prototype, "scrollTo"),
          requestAnimationFrame,
        ]) {
          if (vi.isMockFunction(mock)) {
            mock.mockClear();
          }
        }
        const control = new WeakRef({ unowned: true });
        await collectGarbageForTest();
        expect({
          controlAlive: control.deref() !== undefined,
          removedDomAlive: removed.deref() !== undefined,
          obsoleteSourcesAndFrames: obsolete.filter(hasLiveTarget).length,
        }).toEqual({ controlAlive: false, removedDomAlive: false, obsoleteSourcesAndFrames: 0 });
        expect(host.connected).toBe(true);
      } finally {
        disposed = true;
        host.dispose();
        container.remove();
        resetChatThreadState(paneId);
      }
    },
  );

  it("releases the admitted cache after terminal host disposal", async () => {
    const host = new ChatSessionVirtualizerHost(() => {});
    const admitAndDispose = () => {
      const cache: ChatMessageCache = new Map();
      const message = { role: "assistant", content: "retired cached transcript" };
      const target = { sessionKey: "agent:main:layout-lifetime" };
      cacheChatSessionSnapshot(cache, {}, target, {
        messages: [message],
        pagination: { hasMore: false },
        sessionId: "session-1",
      });
      host.layout.configureRows(
        threadProps("layout-disposal", target.sessionKey, [], {
          widgetLayout: createChatWidgetLayout()(cache, {}, target),
        }),
        "gutter",
        false,
      );
      host.render(
        [{ kind: "item", key: "row", revision: "revision", item: message }],
        () => null,
        null,
        false,
      );
      host.dispose();
      return new WeakRef(message);
    };
    const obsolete = admitAndDispose();
    const control = new WeakRef({ unowned: true });

    await collectGarbageForTest();
    expect(hasLiveTarget(control)).toBe(false);
    expect(hasLiveTarget(obsolete)).toBe(false);
    expect(host.layout.rows).toEqual([]);
    expect(host.layout.rowLayout).toBeUndefined();
  });
});
