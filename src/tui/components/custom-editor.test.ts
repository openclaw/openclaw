// Custom editor tests cover TUI editor key handling and cursor behavior.
import { CombinedAutocompleteProvider, type TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSlashCommands, shouldSubmitExactArgumentCompletion } from "../commands.js";
import { editorTheme } from "../theme/theme.js";
import { CustomEditor } from "./custom-editor.js";

function createEditor() {
  return new CustomEditor({ requestRender: vi.fn() } as unknown as TUI, editorTheme);
}

function createAutocompleteEditor() {
  const editor = createEditor();
  const commands = getSlashCommands();
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, process.cwd()));
  editor.shouldSubmitAutocomplete = (text) => shouldSubmitExactArgumentCompletion(text, commands);
  return editor;
}

async function typeText(editor: CustomEditor, text: string) {
  for (const character of text) {
    editor.handleInput(character);
  }
  await vi.waitFor(() => expect(editor.isShowingAutocomplete()).toBe(true));
}

describe("CustomEditor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { name: "Kitty Shift+Enter", input: "\u001b[13;2u" },
    { name: "Ctrl+J", input: "\n" },
  ])("inserts a newline without submitting on $name", ({ input }) => {
    const editor = createEditor();
    const onSubmit = vi.fn();
    editor.onSubmit = onSubmit;
    editor.setText("first line");

    editor.handleInput(input);

    expect(editor.getText()).toBe("first line\n");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("routes alt+enter to the follow-up handler", () => {
    const editor = createEditor();
    const onAltEnter = vi.fn();
    editor.onAltEnter = onAltEnter;

    editor.handleInput("\u001b\r");

    expect(onAltEnter).toHaveBeenCalledTimes(1);
  });

  it("routes alt+up to the dequeue handler", () => {
    const editor = createEditor();
    const onAltUp = vi.fn();
    editor.onAltUp = onAltUp;

    editor.handleInput("\u001bp");

    expect(onAltUp).toHaveBeenCalledTimes(1);
  });

  it("uses Ctrl+D to request exit only when the editor is empty", () => {
    const editor = createEditor();
    const onCtrlD = vi.fn();
    editor.onCtrlD = onCtrlD;

    editor.handleInput("\u0004");

    expect(onCtrlD).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toBe("");
  });

  it.each([
    { name: "joins lines", text: "first\nsecond", keys: ["\u001b[A"], expected: "firstsecond" },
    {
      name: "deletes a complete grapheme",
      text: "a👨‍👩‍👧‍👦b",
      keys: ["\u001b[D", "\u001b[D"],
      expected: "ab",
    },
    { name: "does nothing at the final cursor", text: "keepword", keys: [], expected: "keepword" },
  ])("Ctrl+D $name without exiting nonempty input", ({ text, keys, expected }) => {
    const editor = createEditor();
    const onCtrlD = vi.fn();
    editor.onCtrlD = onCtrlD;
    editor.setText(text);
    for (const key of keys) {
      editor.handleInput(key);
    }
    editor.handleInput("\u0004");

    expect(editor.getText()).toBe(expected);
    expect(onCtrlD).not.toHaveBeenCalled();
  });

  it("uses Ctrl+D to edit recalled input history without requesting exit", () => {
    const editor = createEditor();
    const onCtrlD = vi.fn();
    editor.onCtrlD = onCtrlD;
    editor.addToHistory("history");

    editor.handleInput("\u001b[A");
    editor.handleInput("\u0001");
    editor.handleInput("\u0004");

    expect(editor.getText()).toBe("istory");
    expect(onCtrlD).not.toHaveBeenCalled();
  });

  it("inserts German AltGr printable Kitty CSI-u input", () => {
    const editor = createEditor();

    editor.handleInput("\u001b[64::113;7u");
    editor.handleInput("\u001b[8364::101;7u");

    expect(editor.getText()).toBe("@€");
  });

  it("does not insert ordinary Alt-modified Kitty CSI-u input", () => {
    const editor = createEditor();

    editor.handleInput("\u001b[113;3u");

    expect(editor.getText()).toBe("");
  });

  it("ignores printable Kitty key release events", () => {
    const editor = createEditor();

    editor.handleInput("\u001b[214;1u");
    editor.handleInput("\u001b[214;1:3u");

    expect(editor.getText()).toBe("Ö");
  });

  it("submits an exact sole argument completion with one Enter", async () => {
    const editor = createAutocompleteEditor();
    const onSubmit = vi.fn();
    editor.onSubmit = onSubmit;
    await typeText(editor, "/think high");

    editor.handleInput("\r");

    expect(onSubmit).toHaveBeenCalledWith("/think high");
    expect(editor.getText()).toBe("");
  });

  it("keeps Enter as completion acceptance when multiple arguments match", async () => {
    const editor = createAutocompleteEditor();
    const onSubmit = vi.fn();
    editor.onSubmit = onSubmit;
    await typeText(editor, "/fast o");

    editor.handleInput("\r");

    expect(onSubmit).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("/fast on");
  });

  it.each(["/help", "/hel"])("completes and submits %s with one Enter", async (input) => {
    const editor = createAutocompleteEditor();
    const onSubmit = vi.fn();
    editor.onSubmit = onSubmit;
    await typeText(editor, input);

    editor.handleInput("\r");

    expect(onSubmit).toHaveBeenCalledWith("/help");
  });

  it("preserves multiline boundaries around an accepted command completion", async () => {
    const editor = createAutocompleteEditor();
    const onSubmit = vi.fn();
    editor.onSubmit = onSubmit;
    editor.setText("\n");
    editor.handleInput("\u001b[A");
    await typeText(editor, "/hel");

    editor.handleInput("\r");

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("/help\n");
  });

  it("does not expand stored paste text for ordinary input", () => {
    const editor = createEditor();
    editor.setText("draft");
    const getExpandedText = vi.spyOn(editor, "getExpandedText");

    editor.handleInput("x");

    expect(getExpandedText).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("draftx");
  });
});
