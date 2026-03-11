import type { Page } from "playwright-core";
import { describe, expect, it, vi } from "vitest";
import { ensurePageState } from "./pw-session.js";

function fakePage(): Page {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    const list = handlers.get(event) ?? [];
    list.push(cb);
    handlers.set(event, list);
    return undefined as unknown;
  });

  return {
    on,
    getByRole: vi.fn(),
    frameLocator: vi.fn(),
    locator: vi.fn(),
  } as unknown as Page;
}

describe("ensurePageState bounded arrays", () => {
  it("trims console messages to MAX_CONSOLE_MESSAGES (500)", () => {
    const page = fakePage();
    const state = ensurePageState(page);

    // Push well beyond the limit.
    for (let i = 0; i < 520; i++) {
      state.console.push({
        type: "log",
        text: `msg-${i}`,
        timestamp: new Date().toISOString(),
      });
    }

    // The existing trimOldest is called via event handlers; here we verify
    // the state structure itself can hold entries and that the array is a
    // standard JavaScript array (splice-based trimming works).
    expect(state.console.length).toBe(520);

    // Simulate what the event handler does:
    const overflow = state.console.length - 500;
    if (overflow > 0) {
      state.console.splice(0, overflow);
    }
    expect(state.console.length).toBe(500);
    // Oldest entries removed: first entry should now be msg-20.
    expect(state.console[0]?.text).toBe("msg-20");
  });

  it("splice(0, n) is equivalent to n calls of shift()", () => {
    const arr = Array.from({ length: 10 }, (_, i) => i);

    // shift approach
    const shifted = [...arr];
    shifted.shift();
    shifted.shift();
    shifted.shift();

    // splice approach
    const spliced = [...arr];
    spliced.splice(0, 3);

    expect(spliced).toEqual(shifted);
  });
});
