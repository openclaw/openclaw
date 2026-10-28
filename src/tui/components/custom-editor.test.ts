import { CombinedAutocompleteProvider, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSlashCommands, shouldSubmitExactArgumentCompletion } from "../commands.js";
import { editorTheme } from "../theme/theme.js";
import { CustomEditor } from "./custom-editor.js";

describe("CustomEditor", () => {
  let editor: CustomEditor;
  let onSubmit: ReturnType<typeof vi.fn<(text: string) => void>>;
  let onCtrlD: ReturnType<typeof vi.fn<() => void>>;
  beforeEach(() => {
    editor = new CustomEditor({ requestRender: vi.fn() } as unknown as TUI, editorTheme);
    editor.onSubmit = onSubmit = vi.fn<(text: string) => void>();
    editor.onCtrlD = onCtrlD = vi.fn<() => void>();
  });
  afterEach(() => vi.restoreAllMocks());

  async function complete(text: string) {
    const commands = getSlashCommands();
    editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, process.cwd()));
    editor.shouldSubmitAutocomplete = (value) =>
      shouldSubmitExactArgumentCompletion(value, commands);
    for (const character of text) {
      editor.handleInput(character);
    }
    await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
    editor.handleInput("\r");
  }

  it("uses Ctrl+D to request exit only when the editor is empty", () => {
    editor.handleInput("\u0004");

    expect(onCtrlD).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toBe("");
  });

  it("Ctrl+D deletes a complete grapheme without exiting nonempty input", () => {
    editor.setText("a👨‍👩‍👧‍👦b");
    editor.handleInput("\u001b[D");
    editor.handleInput("\u001b[D");
    editor.handleInput("\u0004");

    expect(editor.getText()).toBe("ab");
    expect(onCtrlD).not.toHaveBeenCalled();
  });

  it.each([
    ["AltGr characters", ["\u001b[64::113;7u", "\u001b[8364::101;7u"], "@€"],
    ["key release ignored", ["\u001b[214;1u", "\u001b[214;1:3u"], "Ö"],
  ] as const)("handles Kitty input: %s", (_name, keys, expected) => {
    for (const key of keys) {
      editor.handleInput(key);
    }
    expect(editor.getText()).toBe(expected);
  });

  it("submits an exact sole argument completion with one Enter", async () => {
    await complete("/think high");

    expect(onSubmit).toHaveBeenCalledWith("/think high");
    expect(editor.getText()).toBe("");
  });

  it("keeps Enter as completion acceptance when multiple arguments match", async () => {
    await complete("/fast o");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("/fast on");
  });

  it("completes and submits /help with one Enter", async () => {
    await complete("/help");

    expect(onSubmit).toHaveBeenCalledWith("/help");
  });

  it("preserves multiline boundaries around an accepted command completion", async () => {
    editor.setText("\n");
    editor.handleInput("\u001b[A");
    await complete("/hel");

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("/help\n");
  });
});

describe("CustomEditor in screen reader mode", () => {
  const make = (screenReader: boolean) => {
    const editor = new CustomEditor(
      { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI,
      editorTheme,
      screenReader,
    );
    editor.focused = true;
    editor.setText("hello");
    return editor.render(40);
  };

  it("starts the input line with a $ marker and drops border rows", () => {
    const lines = make(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith("$ hello")).toBe(true);
    expect(lines[0]).toContain("\u001b_pi:c\u0007");
  });

  it("says how many draft lines are hidden and keeps the $ marker on the first text row", () => {
    const editor = new CustomEditor(
      { requestRender: vi.fn(), terminal: { rows: 24 } } as unknown as TUI,
      editorTheme,
      true,
    );
    editor.setText(Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n"));
    const lines = editor.render(40);
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe("3 more lines above");
    expect(lines[1]?.startsWith("$ line 3")).toBe(true);
    expect(lines.join("\n")).not.toContain("─");
  });

  it("wraps the hidden line notice to a narrow terminal and keeps the direction", () => {
    const editor = new CustomEditor(
      { requestRender: vi.fn(), terminal: { rows: 24 } } as unknown as TUI,
      editorTheme,
      true,
    );
    editor.setText(Array.from({ length: 10 }, (_, index) => `${index}`).join("\n"));
    const lines = editor.render(10);
    expect(lines.slice(0, 2)).toEqual(["more lines", "above"]);
    expect(lines.every((line) => visibleWidth(line) <= 10)).toBe(true);
  });

  it("parks the cursor on the selected suggestion while autocomplete is open", async () => {
    const { default: chalk } = await import("chalk");
    const saved = chalk.level;
    chalk.level = 0;
    try {
      const editor = new CustomEditor(
        { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI,
        editorTheme,
        true,
      );
      editor.focused = true;
      editor.setAutocompleteProvider(
        new CombinedAutocompleteProvider(getSlashCommands(), process.cwd()),
      );
      for (const character of "/hel") {
        editor.handleInput(character);
      }
      await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
      const lines = editor.render(60);
      const parked = lines.filter((line) => line.includes("\u001b_pi:c\u0007"));
      expect(parked).toHaveLength(1);
      expect(parked[0]?.startsWith("    \u001b_pi:c\u0007help")).toBe(true);
      expect(lines[0]?.startsWith("$ /hel")).toBe(true);
    } finally {
      chalk.level = saved;
    }
  });

  it("keeps the bordered layout without the marker by default", () => {
    const lines = make(false);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).not.toContain("$ ");
  });
});
