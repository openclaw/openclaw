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

  it("uses Ctrl+D to request exit only when the editor is empty", () => {
    const editor = createEditor();
    const onCtrlD = vi.fn();
    editor.onCtrlD = onCtrlD;

    editor.handleInput("\u0004");

    expect(onCtrlD).toHaveBeenCalledTimes(1);
    expect(editor.getText()).toBe("");
  });

  it("Ctrl+D deletes a complete grapheme without exiting nonempty input", () => {
    const editor = createEditor();
    const onCtrlD = vi.fn();
    editor.onCtrlD = onCtrlD;
    editor.setText("a👨‍👩‍👧‍👦b");
    editor.handleInput("\u001b[D");
    editor.handleInput("\u001b[D");
    editor.handleInput("\u0004");

    expect(editor.getText()).toBe("ab");
    expect(onCtrlD).not.toHaveBeenCalled();
  });

  it("inserts German AltGr printable Kitty CSI-u input", () => {
    const editor = createEditor();

    editor.handleInput("\u001b[64::113;7u");
    editor.handleInput("\u001b[8364::101;7u");

    expect(editor.getText()).toBe("@€");
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

  it("completes and submits /help with one Enter", async () => {
    const editor = createAutocompleteEditor();
    const onSubmit = vi.fn();
    editor.onSubmit = onSubmit;
    await typeText(editor, "/help");

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
});
