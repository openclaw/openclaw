import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import { CustomEditor } from "./custom-editor.js";

// ── Minimal TUI mock ─────────────────────────────────────────────────────────

function createMockTui(): TUI {
  return {
    requestRender: vi.fn(),
    terminal: { rows: 24 },
    addChild: vi.fn(),
    removeChild: vi.fn(),
    clear: vi.fn(),
    invalidate: vi.fn(),
    render: vi.fn().mockReturnValue([]),
    setFocus: vi.fn(),
    showOverlay: vi.fn().mockReturnValue({ remove: vi.fn() }),
    addInputListener: vi.fn().mockReturnValue(() => {}),
    removeInputListener: vi.fn(),
    focusedComponent: null,
  } as unknown as TUI;
}

const mockTheme: EditorTheme = {
  borderColor: (s) => s,
  selectList: {
    selectedPrefix: (s) => s,
    selectedText: (s) => s,
    description: (s) => s,
    scrollInfo: (s) => s,
    noMatch: (s) => s,
  },
};

// Helper: type a string into the editor character by character.
function typeText(editor: CustomEditor, text: string): void {
  for (const ch of text) {
    editor.handleInput(ch);
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("CustomEditor — vi mode disabled (default)", () => {
  let editor: CustomEditor;

  beforeEach(() => {
    editor = new CustomEditor(createMockTui(), mockTheme);
  });

  it("getViMode() returns null when vi is not enabled", () => {
    expect(editor.getViMode()).toBeNull();
  });

  it("forwards printable characters to the base editor", () => {
    typeText(editor, "hello");
    expect(editor.getText()).toBe("hello");
  });

  it("calls onEscape when Escape is pressed (non-vi)", () => {
    const onEscape = vi.fn();
    editor.onEscape = onEscape;
    editor.handleInput("\x1b"); // escape sequence
    expect(onEscape).toHaveBeenCalledOnce();
  });
});

describe("CustomEditor — vi mode via options", () => {
  let editor: CustomEditor;

  beforeEach(() => {
    editor = new CustomEditor(createMockTui(), mockTheme, { viMode: true });
  });

  it("getViMode() returns 'insert' on startup", () => {
    expect(editor.getViMode()).toBe("insert");
  });

  it("types normally in insert mode", () => {
    typeText(editor, "hello");
    expect(editor.getText()).toBe("hello");
  });

  it("Escape in insert mode switches to normal mode without calling onEscape", () => {
    const onEscape = vi.fn();
    editor.onEscape = onEscape;
    editor.handleInput("\x1b");
    expect(editor.getViMode()).toBe("normal");
    expect(onEscape).not.toHaveBeenCalled();
  });

  it("'i' in normal mode switches back to insert mode", () => {
    editor.handleInput("\x1b"); // → normal
    expect(editor.getViMode()).toBe("normal");
    editor.handleInput("i"); // → insert
    expect(editor.getViMode()).toBe("insert");
  });

  it("'a' in normal mode switches to insert mode", () => {
    editor.handleInput("\x1b");
    editor.handleInput("a");
    expect(editor.getViMode()).toBe("insert");
  });

  it("'A' in normal mode switches to insert mode", () => {
    editor.handleInput("\x1b");
    editor.handleInput("A");
    expect(editor.getViMode()).toBe("insert");
  });

  it("'I' in normal mode switches to insert mode", () => {
    editor.handleInput("\x1b");
    editor.handleInput("I");
    expect(editor.getViMode()).toBe("insert");
  });

  it("typing in normal mode does not change text", () => {
    typeText(editor, "hello");
    editor.handleInput("\x1b"); // → normal
    editor.handleInput("z"); // unrecognised → swallowed
    expect(editor.getText()).toBe("hello");
  });

  it("Escape in normal mode calls onEscape", () => {
    const onEscape = vi.fn();
    editor.onEscape = onEscape;
    editor.handleInput("\x1b"); // insert → normal
    editor.handleInput("\x1b"); // normal → onEscape
    expect(onEscape).toHaveBeenCalledOnce();
  });

  describe("cursor movement in normal mode", () => {
    beforeEach(() => {
      typeText(editor, "hello");
      editor.handleInput("\x1b"); // enter normal mode; cursor at col 5
    });

    it("'h' moves cursor left", () => {
      const before = editor.getCursor().col;
      editor.handleInput("h");
      expect(editor.getCursor().col).toBe(before - 1);
    });

    it("'l' moves cursor right after moving left", () => {
      editor.handleInput("h"); // col 4
      const col = editor.getCursor().col;
      editor.handleInput("l"); // col 5
      expect(editor.getCursor().col).toBe(col + 1);
    });

    it("multiple 'h' presses move cursor left repeatedly", () => {
      editor.handleInput("h");
      editor.handleInput("h");
      editor.handleInput("h");
      expect(editor.getCursor().col).toBe(2);
    });
  });

  describe("dd — delete line", () => {
    it("dd on single-line clears the text", () => {
      typeText(editor, "hello");
      editor.handleInput("\x1b");
      editor.handleInput("d");
      editor.handleInput("d");
      expect(editor.getText()).toBe("");
    });

    it("first 'd' alone does not delete", () => {
      typeText(editor, "hello");
      editor.handleInput("\x1b");
      editor.handleInput("d");
      expect(editor.getText()).toBe("hello");
    });

    it("pendingD resets when a non-d key is pressed", () => {
      typeText(editor, "hello");
      editor.handleInput("\x1b");
      editor.handleInput("d");
      editor.handleInput("h"); // move left — resets pendingD
      editor.handleInput("d"); // first 'd' of new potential 'dd'
      expect(editor.getText()).toBe("hello"); // not deleted yet
    });
  });

  describe("callbacks still fire in insert mode", () => {
    it("onCtrlL fires in insert mode", () => {
      const cb = vi.fn();
      editor.onCtrlL = cb;
      editor.handleInput("\x0c"); // ctrl+l
      expect(cb).toHaveBeenCalledOnce();
    });

    it("onCtrlC fires in normal mode (falls through)", () => {
      const cb = vi.fn();
      editor.onCtrlC = cb;
      editor.handleInput("\x1b"); // → normal
      editor.handleInput("\x03"); // ctrl+c
      expect(cb).toHaveBeenCalledOnce();
    });
  });
});

describe("CustomEditor — vi mode via OPENCLAW_TUI_VI_MODE env var", () => {
  const originalEnv = process.env.OPENCLAW_TUI_VI_MODE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.OPENCLAW_TUI_VI_MODE;
    } else {
      process.env.OPENCLAW_TUI_VI_MODE = originalEnv;
    }
  });

  it("OPENCLAW_TUI_VI_MODE=1 enables vi mode", () => {
    process.env.OPENCLAW_TUI_VI_MODE = "1";
    const editor = new CustomEditor(createMockTui(), mockTheme);
    expect(editor.getViMode()).toBe("insert");
  });

  it("OPENCLAW_TUI_VI_MODE=true enables vi mode", () => {
    process.env.OPENCLAW_TUI_VI_MODE = "true";
    const editor = new CustomEditor(createMockTui(), mockTheme);
    expect(editor.getViMode()).toBe("insert");
  });

  it("OPENCLAW_TUI_VI_MODE=0 does not enable vi mode", () => {
    process.env.OPENCLAW_TUI_VI_MODE = "0";
    const editor = new CustomEditor(createMockTui(), mockTheme);
    expect(editor.getViMode()).toBeNull();
  });

  it("options.viMode=true takes precedence when env var is absent", () => {
    delete process.env.OPENCLAW_TUI_VI_MODE;
    const editor = new CustomEditor(createMockTui(), mockTheme, { viMode: true });
    expect(editor.getViMode()).toBe("insert");
  });
});
