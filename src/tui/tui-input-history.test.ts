import { describe, expect, it, vi } from "vitest";

import { createEditorSubmitHandler } from "./tui.js";

describe("createEditorSubmitHandler", () => {
  it("adds submitted messages to editor history", () => {
    const editor = {
      setText: vi.fn(),
      addToHistory: vi.fn(),
    };

    const handler = createEditorSubmitHandler({
      editor,
      handleCommand: vi.fn(),
      sendMessage: vi.fn(),
    });

    handler("hello world");

    expect(editor.setText).toHaveBeenCalledWith("");
    expect(editor.addToHistory).toHaveBeenCalledWith("hello world");
  });

  it("trims input before adding to history", () => {
    const editor = {
      setText: vi.fn(),
      addToHistory: vi.fn(),
    };

    const handler = createEditorSubmitHandler({
      editor,
      handleCommand: vi.fn(),
      sendMessage: vi.fn(),
    });

    handler("   hi   ");

    expect(editor.addToHistory).toHaveBeenCalledWith("hi");
  });

  it("does not add empty submissions to history", () => {
    const editor = {
      setText: vi.fn(),
      addToHistory: vi.fn(),
    };

    const handler = createEditorSubmitHandler({
      editor,
      handleCommand: vi.fn(),
      sendMessage: vi.fn(),
    });

    handler("   ");

    expect(editor.addToHistory).not.toHaveBeenCalled();
  });

  it("routes slash commands to handleCommand", () => {
    const editor = {
      setText: vi.fn(),
      addToHistory: vi.fn(),
    };
    const handleCommand = vi.fn();
    const sendMessage = vi.fn();

    const handler = createEditorSubmitHandler({
      editor,
      handleCommand,
      sendMessage,
    });

    handler("/models");

    expect(editor.addToHistory).toHaveBeenCalledWith("/models");
    expect(handleCommand).toHaveBeenCalledWith("/models");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("routes normal messages to sendMessage", () => {
    const editor = {
      setText: vi.fn(),
      addToHistory: vi.fn(),
    };
    const handleCommand = vi.fn();
    const sendMessage = vi.fn();

    const handler = createEditorSubmitHandler({
      editor,
      handleCommand,
      sendMessage,
    });

    handler("hello");

    expect(editor.addToHistory).toHaveBeenCalledWith("hello");
    expect(sendMessage).toHaveBeenCalledWith("hello");
    expect(handleCommand).not.toHaveBeenCalled();
  });
});
