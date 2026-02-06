import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInternalHookEvent, type InternalHookEvent } from "./internal-hooks.js";
import {
  clearPriorityHooks,
  getPriorityHookStats,
  listPriorityHooks,
  oncePriorityHook,
  registerPriorityHook,
  triggerPriorityHook,
  unregisterPriorityHook,
} from "./priority-hooks.js";

function makeEvent(
  type: "command" | "session" | "agent" | "gateway" = "command",
  action = "new",
): InternalHookEvent {
  return createInternalHookEvent(type, action, "test-session");
}

describe("priority-hooks", () => {
  beforeEach(() => clearPriorityHooks());
  afterEach(() => clearPriorityHooks());

  describe("registerPriorityHook", () => {
    it("returns a unique hook id", () => {
      const id1 = registerPriorityHook("command:new", vi.fn());
      const id2 = registerPriorityHook("command:new", vi.fn());
      expect(id1).not.toBe(id2);
    });

    it("defaults to priority 50", () => {
      registerPriorityHook("command:new", vi.fn());
      const list = listPriorityHooks("command:new");
      expect(list[0].priority).toBe(50);
    });
  });

  describe("triggerPriorityHook", () => {
    it("executes handlers in priority order", async () => {
      const order: string[] = [];
      registerPriorityHook("command:new", () => { order.push("plugin"); }, { priority: 50 });
      registerPriorityHook("command:new", () => { order.push("security"); }, { priority: 1 });
      registerPriorityHook("command:new", () => { order.push("logging"); }, { priority: 100 });
      registerPriorityHook("command:new", () => { order.push("core"); }, { priority: 10 });

      await triggerPriorityHook(makeEvent());
      expect(order).toEqual(["security", "core", "plugin", "logging"]);
    });

    it("preserves insertion order for equal priorities", async () => {
      const order: string[] = [];
      registerPriorityHook("command:new", () => { order.push("first"); }, { priority: 50 });
      registerPriorityHook("command:new", () => { order.push("second"); }, { priority: 50 });
      registerPriorityHook("command:new", () => { order.push("third"); }, { priority: 50 });

      await triggerPriorityHook(makeEvent());
      expect(order).toEqual(["first", "second", "third"]);
    });

    it("merges general type and specific action handlers", async () => {
      const order: string[] = [];
      registerPriorityHook("command", () => { order.push("general"); }, { priority: 50 });
      registerPriorityHook("command:new", () => { order.push("specific"); }, { priority: 1 });

      await triggerPriorityHook(makeEvent());
      // specific has lower priority number → runs first
      expect(order).toEqual(["specific", "general"]);
    });

    it("catches errors without stopping other handlers", async () => {
      const results: string[] = [];
      registerPriorityHook("command:new", () => { results.push("before"); }, { priority: 1 });
      registerPriorityHook("command:new", () => { throw new Error("boom"); }, { priority: 50 });
      registerPriorityHook("command:new", () => { results.push("after"); }, { priority: 100 });

      const errors = await triggerPriorityHook(makeEvent());
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe("boom");
      expect(results).toEqual(["before", "after"]);
    });

    it("returns empty array when no handlers registered", async () => {
      const errors = await triggerPriorityHook(makeEvent());
      expect(errors).toEqual([]);
    });
  });

  describe("oncePriorityHook", () => {
    it("fires once then auto-removes", async () => {
      let count = 0;
      oncePriorityHook("command:new", () => { count++; }, 50);

      await triggerPriorityHook(makeEvent());
      await triggerPriorityHook(makeEvent());
      expect(count).toBe(1);
    });
  });

  describe("unregisterPriorityHook", () => {
    it("removes handler by id", async () => {
      let called = false;
      const id = registerPriorityHook("command:new", () => { called = true; });
      unregisterPriorityHook("command:new", id);

      await triggerPriorityHook(makeEvent());
      expect(called).toBe(false);
    });

    it("returns false for unknown id", () => {
      expect(unregisterPriorityHook("command:new", "phook_999")).toBe(false);
    });
  });

  describe("listPriorityHooks", () => {
    it("returns handlers sorted by priority", () => {
      registerPriorityHook("command:new", vi.fn(), { priority: 90, label: "logging" });
      registerPriorityHook("command:new", vi.fn(), { priority: 1, label: "security" });
      registerPriorityHook("command:new", vi.fn(), { priority: 50, label: "plugin" });

      const list = listPriorityHooks("command:new");
      expect(list[0].label).toBe("security");
      expect(list[1].label).toBe("plugin");
      expect(list[2].label).toBe("logging");
    });

    it("returns empty array for unknown event", () => {
      expect(listPriorityHooks("unknown")).toEqual([]);
    });
  });

  describe("getPriorityHookStats", () => {
    it("tracks events, handlers, and emits", async () => {
      registerPriorityHook("command:new", vi.fn());
      registerPriorityHook("command:new", vi.fn());
      registerPriorityHook("session:start", vi.fn());

      await triggerPriorityHook(makeEvent("command", "new"));
      await triggerPriorityHook(makeEvent("command", "new"));

      const stats = getPriorityHookStats();
      expect(stats.events).toBe(2);
      expect(stats.handlers).toBe(3);
      expect(stats.totalEmits).toBe(2);
    });
  });

  describe("clearPriorityHooks", () => {
    it("removes all handlers and resets counters", () => {
      registerPriorityHook("command:new", vi.fn());
      clearPriorityHooks();

      const stats = getPriorityHookStats();
      expect(stats.events).toBe(0);
      expect(stats.handlers).toBe(0);
    });
  });
});
