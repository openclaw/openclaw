// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectGarbageForTest } from "../../../test-helpers/garbage-collection.ts";
import { buildChatItems } from "../chat-thread-build.ts";
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
import { ChatSessionVirtualizerHost } from "./chat-transcript-virtualizer-host.ts";
import {
  installTranscriptDomMocks,
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
