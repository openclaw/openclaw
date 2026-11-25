import { CombinedAutocompleteProvider, type TUI } from "@earendil-works/pi-tui";
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
