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

  it("returns Plan mode for deny + off", () => {
    const mode = resolveCurrentMode("deny", "off");
    expect(mode.id).toBe("plan");
  });

  it("returns Bypass permissions for full + off", () => {
    const mode = resolveCurrentMode("full", "off");
    expect(mode.id).toBe("bypass");
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

  it("returns correct mode for Ctrl+1 through Ctrl+4", () => {
    for (const mode of MODE_DEFINITIONS) {
      const result = handleModeShortcut(makeKeyEvent(mode.shortcut, true, false));
      expect(result).not.toBeNull();
      expect(result!.id).toBe(mode.id);
    }
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
