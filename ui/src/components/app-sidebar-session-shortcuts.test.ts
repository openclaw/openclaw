import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSidebarSessionShortcuts,
  MAX_RECENT_SIDEBAR_SESSIONS,
  RecentSidebarSessions,
  resolveAdjacentSession,
  resolveSessionJumpTarget,
} from "./app-sidebar-session-shortcuts.ts";

type NativeWindow = Window & { __OPENCLAW_NATIVE_WEB_CHROME__?: boolean };

const rows = ["a", "b", "c", "d"];

function setup(options: { current?: string; rows?: string[] } = {}) {
  let current = options.current ?? "a";
  const opened: string[] = [];
  const shortcuts = createSidebarSessionShortcuts({
    ownerDocument: () => document,
    isConnected: () => true,
    visibleSessionKeysInOrder: () => options.rows ?? rows,
    currentSessionKey: () => current,
    canOpenSession: (key) => (options.rows ?? rows).includes(key),
    openSession: (key) => {
      opened.push(key);
      current = key;
      shortcuts.observe(key);
    },
  });
  shortcuts.observe(current);
  shortcuts.connect();
  const visit = (key: string) => {
    current = key;
    shortcuts.observe(key);
  };
  return { shortcuts, opened, visit };
}

function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  document.body.dispatchEvent(event);
  return event;
}

function release(init: KeyboardEventInit = {}): void {
  document.body.dispatchEvent(
    new KeyboardEvent("keyup", { bubbles: true, key: "Control", ...init }),
  );
}

describe("sidebar session shortcut targets", () => {
  it("opens rows by position and sends 9 to the last row", () => {
    expect(resolveSessionJumpTarget(1, rows)).toBe("a");
    expect(resolveSessionJumpTarget(3, rows)).toBe("c");
    expect(resolveSessionJumpTarget(8, rows)).toBeUndefined();
    expect(resolveSessionJumpTarget(9, rows)).toBe("d");
    expect(resolveSessionJumpTarget(9, [])).toBeUndefined();
  });

  it("falls back to the neighboring row and wraps at the ends", () => {
    expect(resolveAdjacentSession(1, "b", rows)).toBe("c");
    expect(resolveAdjacentSession(1, "d", rows)).toBe("a");
    expect(resolveAdjacentSession(-1, "a", rows)).toBe("d");
    expect(resolveAdjacentSession(1, "elsewhere", rows)).toBe("a");
    expect(resolveAdjacentSession(1, "a", ["a"])).toBeUndefined();
  });
});

describe("recent sidebar sessions", () => {
  it("walks one frozen order while Control is held and promotes the final stop", () => {
    const recent = new RecentSidebarSessions();
    for (const key of ["a", "b", "c"]) {
      recent.visit(key);
    }
    const open = () => true;
    expect(recent.step(1, "c", open)).toBe("b");
    // The walk's own navigation must not reorder the snapshot it is walking.
    recent.visit("b");
    expect(recent.step(1, "b", open)).toBe("a");
    expect(recent.step(-1, "a", open)).toBe("b");
    recent.finish();
    expect(recent.order).toEqual(["b", "c", "a"]);
    expect(recent.step(1, "b", open)).toBe("c");
  });

  it("skips sessions that can no longer be opened", () => {
    const recent = new RecentSidebarSessions();
    for (const key of ["a", "archived", "b"]) {
      recent.visit(key);
    }
    expect(recent.step(1, "b", (key) => key !== "archived")).toBe("a");
  });

  it("needs a second recent session before it walks", () => {
    const recent = new RecentSidebarSessions();
    expect(recent.step(1, "a", () => true)).toBeNull();
    expect(recent.walking).toBe(false);
  });

  it("keeps a bounded history", () => {
    const recent = new RecentSidebarSessions();
    for (let index = 0; index < MAX_RECENT_SIDEBAR_SESSIONS + 5; index++) {
      recent.visit(`session-${index}`);
    }
    expect(recent.order).toHaveLength(MAX_RECENT_SIDEBAR_SESSIONS);
    expect(recent.order[0]).toBe(`session-${MAX_RECENT_SIDEBAR_SESSIONS + 4}`);
  });
});

describe("sidebar session shortcut keys", () => {
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    (window as NativeWindow)["__OPENCLAW_NATIVE_WEB_CHROME__"] = true;
  });

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
    vi.restoreAllMocks();
    delete (window as NativeWindow)["__OPENCLAW_NATIVE_WEB_CHROME__"];
  });

  function connect(options?: Parameters<typeof setup>[0]) {
    const result = setup(options);
    cleanup = () => result.shortcuts.disconnect();
    return result;
  }

  it("opens the numbered sidebar row with Command and claims the chord", () => {
    const { opened } = connect();
    const second = press({ key: "2", code: "Digit2", metaKey: true });
    expect(second.defaultPrevented).toBe(true);
    const last = press({ key: "9", code: "Digit9", metaKey: true });
    expect(last.defaultPrevented).toBe(true);
    // No fifth row: the chord is still claimed so the host menu cannot reuse it.
    const missing = press({ key: "5", code: "Digit5", metaKey: true });
    expect(missing.defaultPrevented).toBe(true);
    expect(opened).toEqual(["b", "d"]);
  });

  it("accepts layouts that type a symbol on the digit row", () => {
    const { opened } = connect();
    press({ key: '"', code: "Digit3", metaKey: true });
    expect(opened).toEqual(["c"]);
  });

  it("ignores repeats, other modifiers, composition, and browsers", () => {
    const { opened } = connect();
    press({ key: "2", code: "Digit2", metaKey: true, repeat: true });
    press({ key: "2", code: "Digit2", ctrlKey: true });
    press({ key: "2", code: "Digit2", metaKey: true, shiftKey: true });
    press({ key: "2", code: "Digit2", metaKey: true, isComposing: true });
    delete (window as NativeWindow)["__OPENCLAW_NATIVE_WEB_CHROME__"];
    const browser = press({ key: "2", code: "Digit2", metaKey: true });
    expect(browser.defaultPrevented).toBe(false);
    expect(opened).toEqual([]);
  });

  it("leaves open modal dialogs in control", () => {
    const { opened } = connect();
    const modal = document.createElement("div");
    document.openClawModalLayers = new Set([modal]);
    try {
      const event = press({ key: "2", code: "Digit2", metaKey: true });
      expect(event.defaultPrevented).toBe(false);
    } finally {
      document.openClawModalLayers = undefined;
    }
    expect(opened).toEqual([]);
  });

  it("switches to the previous session with Control+Tab and walks further while held", () => {
    const { opened, visit } = connect();
    visit("c");
    visit("b");
    const first = press({ key: "Tab", code: "Tab", ctrlKey: true });
    expect(first.defaultPrevented).toBe(true);
    press({ key: "Tab", code: "Tab", ctrlKey: true });
    release();
    expect(opened).toEqual(["c", "a"]);
    // The final stop became the most recent, so a quick Control+Tab returns to b.
    press({ key: "Tab", code: "Tab", ctrlKey: true });
    release();
    expect(opened).toEqual(["c", "a", "b"]);
    press({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true });
    release();
    expect(opened.at(-1)).toBe("c");
  });

  it("moves to the next row before a second session was opened", () => {
    const { opened } = connect({ current: "b" });
    press({ key: "Tab", code: "Tab", ctrlKey: true });
    release();
    expect(opened).toEqual(["c"]);
  });

  it("stops listening after disconnect", () => {
    const { opened, shortcuts } = connect();
    shortcuts.disconnect();
    press({ key: "2", code: "Digit2", metaKey: true });
    expect(opened).toEqual([]);
  });
});
