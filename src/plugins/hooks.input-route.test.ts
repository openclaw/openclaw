import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { isConversationHookName } from "./hook-types.js";
import { createHookRunner } from "./hooks.js";
import { createMockPluginRegistry } from "./hooks.test-fixtures.js";
const event = {
  currentTurn: [{ role: "user" as const, text: "Write a parser." }],
  newMessage: "Handle tabs.",
};
const context = () => ({
  agentId: "main",
  signal: new AbortController().signal,
  deadlineMonotonicMs: 500,
  assertCurrent: vi.fn(),
});
describe("registered advisory input_route contract", () => {
  it("is conversation-scoped and invokes only the highest-priority eligible adviser", async () => {
    const first = vi.fn(() => ({ status: "abstained" as const }));
    const second = vi.fn(() => ({ status: "choice" as const, choice: "steer" as const }));
    const runner = createHookRunner(
      createMockPluginRegistry([
        { hookName: "input_route", pluginId: "first", priority: 10, handler: first },
        { hookName: "input_route", pluginId: "second", handler: second },
      ]),
    );
    expect(isConversationHookName("input_route")).toBe(true);
    expect(await runner.prepareInputRoute(() => true)?.evaluate(event, context())).toEqual({
      status: "abstained",
    });
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(runner.prepareInputRoute(() => false)).toBeUndefined();
  });
  it("never lets the callback replace the authority assertion or alter source evidence", async () => {
    let live = true;
    const original = structuredClone(event);
    const registry = createMockPluginRegistry([
      {
        hookName: "input_route",
        handler: (e, c) => {
          expect(Object.isFrozen(e)).toBe(true);
          expect(Object.isFrozen(c)).toBe(true);
          if (typeof c !== "object" || c === null) {
            throw new Error("Missing hook context");
          }
          expect(Reflect.set(c, "assertCurrent", () => {})).toBe(false);
          live = false;
          return { status: "choice", choice: "steer" };
        },
      },
    ]);
    const ctx = {
      ...context(),
      assertCurrent: () => {
        if (!live) {
          throw new Error("closed");
        }
      },
    };
    await expect(
      createHookRunner(registry)
        .prepareInputRoute(() => true)
        ?.evaluate(event, ctx),
    ).rejects.toThrow("closed");
    expect(event).toEqual(original);
  });
  it("snapshots accessor-backed advice and does not return plugin-owned mutable objects", async () => {
    let reads = 0;
    const raw = {
      status: "choice",
      get choice() {
        return ++reads === 1 ? "steer" : "interrupt";
      },
    };
    const runner = createHookRunner(
      createMockPluginRegistry([{ hookName: "input_route", handler: () => raw }]),
    );
    const result = await runner.prepareInputRoute(() => true)?.evaluate(event, context());
    raw.status = "abstained";
    expect(reads).toBe(1);
    expect(result).not.toBe(raw);
    expect(result).toEqual({ status: "choice", choice: "steer" });
  });
  it("discards a result from a registration replaced while awaiting it", async () => {
    const done = createDeferred<{ status: "choice"; choice: "steer" }>();
    const registry = createMockPluginRegistry([
      { hookName: "input_route", handler: () => done.promise },
    ]);
    const route = createHookRunner(registry).prepareInputRoute(() => true)!;
    const pending = route.evaluate(event, context());
    registry.typedHooks.length = 0;
    done.resolve({ status: "choice", choice: "steer" });
    expect(await pending).toEqual({ status: "unavailable" });
    expect(route.isCurrent()).toBe(false);
  });
});
