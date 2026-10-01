// Covers TUI input history navigation and persistence behavior.
import { describe, expect, it } from "vitest";
import { createSubmitHarness } from "./tui-submit-test-helpers.js";

describe("createEditorSubmitHandler", () => {
  it("does not add whitespace-only submissions to history", () => {
    const { editor, onSubmit } = createSubmitHarness();

    onSubmit("   ");

    expect(editor.addToHistory).not.toHaveBeenCalled();
  });

  it("routes slash commands to handleCommand", () => {
    const { editor, handleCommand, sendMessage, onSubmit } = createSubmitHarness();

    onSubmit("/models");

    expect(editor.addToHistory).toHaveBeenCalledWith("/models");
    expect(handleCommand).toHaveBeenCalledWith("/models");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
