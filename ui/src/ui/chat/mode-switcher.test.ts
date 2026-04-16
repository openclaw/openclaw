import { describe, expect, it } from "vitest";
import { resolveCurrentMode, handleModeShortcut, MODE_DEFINITIONS } from "./mode-switcher.js";

describe("resolveCurrentMode", () => {
  it("returns Ask permissions for allowlist + on-miss", () => {
    const mode = resolveCurrentMode("allowlist", "on-miss");
    expect(mode.id).toBe("ask");
  });

  it("returns Accept edits for allowlist + off", () => {
    const mode = resolveCurrentMode("allowlist", "off");
    expect(mode.id).toBe("accept");
  });

  it("returns Bypass permissions for full + off", () => {
    const mode = resolveCurrentMode("full", "off");
    expect(mode.id).toBe("bypass");
  });

  it("returns Plan mode when planMode='plan' (overrides permission mode display)", () => {
    const mode = resolveCurrentMode("allowlist", "off", "plan");
    expect(mode.id).toBe("plan");
  });

  it("ignores planMode='normal' (falls through to permission mode)", () => {
    const mode = resolveCurrentMode("allowlist", "off", "normal");
    expect(mode.id).toBe("accept");
  });

  it("falls back to Ask permissions for unknown combos", () => {
    const mode = resolveCurrentMode("unknown", "unknown");
    expect(mode.id).toBe("ask");
  });

  it("falls back to Ask permissions for undefined inputs", () => {
    const mode = resolveCurrentMode(undefined, undefined);
    expect(mode.id).toBe("ask");
  });
});

describe("handleModeShortcut", () => {
  function makeKeyEvent(
    key: string,
    ctrl = false,
    meta = false,
    shift = false,
    alt = false,
  ): KeyboardEvent {
    return {
      key,
      ctrlKey: ctrl,
      metaKey: meta,
      shiftKey: shift,
      altKey: alt,
      preventDefault: () => {},
    } as unknown as KeyboardEvent;
  }

  it("returns correct mode for Ctrl+1 through Ctrl+4 (Ask/Accept/Plan/Bypass)", () => {
    for (const mode of MODE_DEFINITIONS) {
      const result = handleModeShortcut(makeKeyEvent(mode.shortcut, true, false));
      expect(result).not.toBeNull();
      expect(result!.id).toBe(mode.id);
    }
  });

  it("Ctrl+3 returns Plan mode", () => {
    const result = handleModeShortcut(makeKeyEvent("3", true, false));
    expect(result?.id).toBe("plan");
    expect(result?.planMode).toBe("plan");
  });

  it("Ctrl+4 returns Bypass mode", () => {
    const result = handleModeShortcut(makeKeyEvent("4", true, false));
    expect(result?.id).toBe("bypass");
  });

  it("returns null for Ctrl+5 (no matching mode)", () => {
    expect(handleModeShortcut(makeKeyEvent("5", true, false))).toBeNull();
  });

  it("returns null for Cmd+1 on macOS (preserves browser tab switching)", () => {
    expect(handleModeShortcut(makeKeyEvent("1", false, true))).toBeNull();
  });

  it("returns null for Ctrl+Cmd+1 (metaKey blocks)", () => {
    expect(handleModeShortcut(makeKeyEvent("1", true, true))).toBeNull();
  });

  it("returns null for plain digit without modifier", () => {
    expect(handleModeShortcut(makeKeyEvent("1", false, false))).toBeNull();
  });

  it("returns null for Ctrl+Shift+1 (extra modifier blocks)", () => {
    expect(handleModeShortcut(makeKeyEvent("1", true, false, true, false))).toBeNull();
  });

  it("returns null for Ctrl+Alt+1 (extra modifier blocks)", () => {
    expect(handleModeShortcut(makeKeyEvent("1", true, false, false, true))).toBeNull();
  });

  it("calls preventDefault when a mode matches", () => {
    let prevented = false;
    const e = {
      key: "1",
      ctrlKey: true,
      metaKey: false,
      preventDefault: () => {
        prevented = true;
      },
    } as unknown as KeyboardEvent;
    handleModeShortcut(e);
    expect(prevented).toBe(true);
  });

  it("does NOT call preventDefault when no mode matches", () => {
    let prevented = false;
    const e = {
      key: "9",
      ctrlKey: true,
      metaKey: false,
      preventDefault: () => {
        prevented = true;
      },
    } as unknown as KeyboardEvent;
    handleModeShortcut(e);
    expect(prevented).toBe(false);
  });
});

describe("focus guard (input/textarea/contenteditable)", () => {
  function makeKeyEvent(key: string): KeyboardEvent {
    return {
      key,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      preventDefault: () => {},
    } as unknown as KeyboardEvent;
  }

  it("returns null when an <input> has focus", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    try {
      expect(handleModeShortcut(makeKeyEvent("1"))).toBeNull();
    } finally {
      input.remove();
    }
  });

  it("returns null when a <textarea> has focus", () => {
    const ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ta.focus();
    try {
      expect(handleModeShortcut(makeKeyEvent("1"))).toBeNull();
    } finally {
      ta.remove();
    }
  });

  it("returns null when a contenteditable element has focus", () => {
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "true");
    div.tabIndex = 0;
    // jsdom doesn't fully implement isContentEditable from the contenteditable
    // attribute, so set the property directly to simulate browser behavior.
    Object.defineProperty(div, "isContentEditable", {
      value: true,
      configurable: true,
    });
    document.body.appendChild(div);
    div.focus();
    try {
      expect(handleModeShortcut(makeKeyEvent("1"))).toBeNull();
    } finally {
      div.remove();
    }
  });

  it("works normally when no input has focus", () => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    const result = handleModeShortcut(makeKeyEvent("1"));
    expect(result?.id).toBe("ask");
  });
});
