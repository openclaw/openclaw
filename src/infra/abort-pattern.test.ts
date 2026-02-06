import { describe, expect, it } from "vitest";

/**
 * Regression test for #7174: Memory leak from closure-wrapped controller.abort().
 *
 * Using `() => controller.abort()` creates a closure that captures the
 * surrounding lexical scope (controller, timer, locals).  In long-running
 * processes these closures accumulate and prevent GC.
 *
 * The fix uses two patterns:
 * - setTimeout: `controller.abort.bind(controller)` (safe, no args passed)
 * - addEventListener: `relayAbort.bind(controller)` where relayAbort is a
 *   module-level function that ignores the Event argument, preserving the
 *   default AbortError reason.
 */

/** Relay abort without forwarding the Event argument as the abort reason. */
function relayAbort(this: AbortController) {
  this.abort();
}

describe("abort pattern: .bind() vs arrow closure (#7174)", () => {
  it("controller.abort.bind(controller) aborts the signal", () => {
    const controller = new AbortController();
    const boundAbort = controller.abort.bind(controller);
    expect(controller.signal.aborted).toBe(false);
    boundAbort();
    expect(controller.signal.aborted).toBe(true);
  });

  it("bound abort works with setTimeout", async () => {
    const controller = new AbortController();
    const timer = setTimeout(controller.abort.bind(controller), 10);
    expect(controller.signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(controller.signal.aborted).toBe(true);
    clearTimeout(timer);
  });

  it("relayAbort.bind() preserves default AbortError reason when used as event listener", () => {
    const parent = new AbortController();
    const child = new AbortController();
    const onAbort = relayAbort.bind(child);

    parent.signal.addEventListener("abort", onAbort, { once: true });
    parent.abort();

    expect(child.signal.aborted).toBe(true);
    // The reason must be the default AbortError, not the Event object
    expect(child.signal.reason).toBeInstanceOf(DOMException);
    expect(child.signal.reason.name).toBe("AbortError");
  });

  it("raw .abort.bind() leaks Event as reason — relayAbort.bind() does not", () => {
    // Demonstrates the bug: .abort.bind() passes the Event as abort reason
    const parentA = new AbortController();
    const childA = new AbortController();
    parentA.signal.addEventListener("abort", childA.abort.bind(childA), { once: true });
    parentA.abort();
    // childA.signal.reason is the Event, NOT an AbortError
    expect(childA.signal.reason).not.toBeInstanceOf(DOMException);

    // The fix: relayAbort.bind() ignores the Event argument
    const parentB = new AbortController();
    const childB = new AbortController();
    parentB.signal.addEventListener("abort", relayAbort.bind(childB), { once: true });
    parentB.abort();
    // childB.signal.reason IS the default AbortError
    expect(childB.signal.reason).toBeInstanceOf(DOMException);
    expect(childB.signal.reason.name).toBe("AbortError");
  });

  it("removeEventListener works with saved relayAbort.bind() reference", () => {
    const parent = new AbortController();
    const child = new AbortController();
    const onAbort = relayAbort.bind(child);

    parent.signal.addEventListener("abort", onAbort);
    parent.signal.removeEventListener("abort", onAbort);
    parent.abort();
    expect(child.signal.aborted).toBe(false);
  });

  it("relayAbort.bind() forwards abort through combined signals", () => {
    // Simulates the combineAbortSignals pattern from pi-tools.abort.ts
    const signalA = new AbortController();
    const signalB = new AbortController();
    const combined = new AbortController();

    const onAbort = relayAbort.bind(combined);
    signalA.signal.addEventListener("abort", onAbort, { once: true });
    signalB.signal.addEventListener("abort", onAbort, { once: true });

    expect(combined.signal.aborted).toBe(false);
    signalA.abort();
    expect(combined.signal.aborted).toBe(true);
    expect(combined.signal.reason).toBeInstanceOf(DOMException);
    expect(combined.signal.reason.name).toBe("AbortError");
  });
});
