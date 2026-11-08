// @vitest-environment node
import { describe, expect, it } from "vitest";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import {
  cacheChatSessionSnapshot,
  createChatWidgetLayout,
  type ChatMessageCache,
} from "./session-message-cache.ts";

const row = 'row:v1:768:appearance:revision:"widget-row"';
const narrowRow = 'row:v1:400:appearance:revision:"widget-row"';
const neighbor = 'row:v1:768:appearance:revision:"neighbor"';
const heights = {
  [row]: 700,
  [narrowRow]: 700,
  [neighbor]: 300,
  "canvas:first": 400,
  "canvas:pending": 600,
};

function hasLiveTarget(reference: WeakRef<object>): boolean {
  // Do not carry a dereferenced JSC temporary across the next GC job.
  return reference.deref() !== undefined;
}

function createRetentionContext(sessionId: string | null) {
  const cache: ChatMessageCache = new Map();
  const host = { assistantAgentId: "main", currentSessionId: sessionId };
  const target = { sessionKey: "agent:main:widget-retention" };
  const layout = createChatWidgetLayout();
  return {
    host,
    layout: () => layout(cache, host, target),
    replace: (id: string) => {
      class Message {
        role = "assistant";
        content = id;
      }
      const message = new Message();
      cacheChatSessionSnapshot(cache, host, target, {
        messages: [message],
        pagination: { hasMore: false },
        sessionId: host.currentSessionId,
        widgetHeights: { ...heights },
      });
      return new WeakRef(message);
    },
  };
}

describe("widget layout transcript retention", () => {
  it.each([
    { lazy: false, sessionId: "session-1" },
    { lazy: true, sessionId: "session-1" },
    { lazy: false, sessionId: null },
    { lazy: true, sessionId: null },
  ])(
    "releases replaced history after admission (lazy=$lazy, sessionId=$sessionId)",
    async ({ lazy, sessionId }) => {
      const context = createRetentionContext(sessionId);
      const layoutBeforeAdmission = lazy ? context.layout() : undefined;
      const obsolete = context.replace("obsolete");
      const layout = layoutBeforeAdmission ?? context.layout();
      expect(layout.read(row)).toBe(700);
      const current = context.replace("current");
      const control = new WeakRef({ unowned: true });

      await collectGarbageForTest();
      expect(hasLiveTarget(control)).toBe(false);
      expect(hasLiveTarget(current)).toBe(true);
      expect(hasLiveTarget(obsolete)).toBe(false);
      expect(context.layout()).toBe(layout);
      expect([layout.read(row), layout.read(neighbor)]).toEqual([700, 300]);
      expect(layout.write("canvas:pending", 200, "widget-row")).toBe(600);
    },
  );

  it("releases history recaptured by settlement while preserving sibling reservations", async () => {
    const context = createRetentionContext("session-1");
    const first = context.replace("first");
    const layout = context.layout();
    const intermediate = context.replace("intermediate");
    expect(layout.write("canvas:first", 200, "widget-row", true)).toBe(200);
    const current = context.replace("current");
    const control = new WeakRef({ unowned: true });

    await collectGarbageForTest();
    expect(hasLiveTarget(control)).toBe(false);
    expect(hasLiveTarget(current)).toBe(true);
    expect(hasLiveTarget(first)).toBe(false);
    expect(hasLiveTarget(intermediate)).toBe(false);
    expect(context.layout()).toBe(layout);
    expect([layout.read(row), layout.read(narrowRow), layout.read(neighbor)]).toEqual([
      undefined,
      undefined,
      300,
    ]);
    expect(layout.write("canvas:pending", 200, "widget-row")).toBe(600);
    expect(layout.write("canvas:pending", 200, "widget-row", true)).toBe(200);
    expect(layout.write("canvas:pending", 100, "widget-row")).toBe(200);

    context.host.currentSessionId = "session-2";
    context.replace("replacement-session");
    expect(layout.readRows()).toBeUndefined();
    expect(layout.write("canvas:pending", 800, "widget-row")).toBeUndefined();
    const replacement = context.layout();
    expect(replacement).not.toBe(layout);
    expect(replacement.read(neighbor)).toBe(300);
  });
});
