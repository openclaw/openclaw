import { describe, expect, it, vi } from "vitest";
import {
  createEditorSubmitHandler,
  createSubmitBurstCoalescer,
  shouldEnableWindowsGitBashPasteFallback,
} from "./tui.js";

function createSubmitHarness() {
  const editor = {
    setText: vi.fn(),
    addToHistory: vi.fn(),
  };
  const handleCommand = vi.fn();
  const sendMessage = vi.fn();
  const handleBangLine = vi.fn();
  const onSubmit = createEditorSubmitHandler({
    editor,
    handleCommand,
    sendMessage,
    handleBangLine,
  });
  return { editor, handleCommand, sendMessage, handleBangLine, onSubmit };
}

describe("createEditorSubmitHandler", () => {
  it("routes lines starting with ! to handleBangLine", () => {
    const { handleCommand, sendMessage, handleBangLine, onSubmit } = createSubmitHarness();

    onSubmit("!ls");

    expect(handleBangLine).toHaveBeenCalledTimes(1);
    expect(handleBangLine).toHaveBeenCalledWith("!ls");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(handleCommand).not.toHaveBeenCalled();
  });

  it("treats a lone ! as a normal message", () => {
    const { sendMessage, handleBangLine, onSubmit } = createSubmitHarness();

    onSubmit("!");

    expect(handleBangLine).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("!");
  });

  it("does not treat leading whitespace before ! as a bang command", () => {
    const { editor, sendMessage, handleBangLine, onSubmit } = createSubmitHarness();

    onSubmit("  !ls");

    expect(handleBangLine).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith("!ls");
    expect(editor.addToHistory).toHaveBeenCalledWith("!ls");
  });

  it("trims normal messages before sending and adding to history", () => {
    const { editor, sendMessage, onSubmit } = createSubmitHarness();

    onSubmit("  hello  ");

    expect(sendMessage).toHaveBeenCalledWith("hello");
    expect(editor.addToHistory).toHaveBeenCalledWith("hello");
  });

  it("preserves internal newlines for multiline messages", () => {
    const { editor, handleCommand, sendMessage, handleBangLine, onSubmit } = createSubmitHarness();

    onSubmit("Line 1\nLine 2\nLine 3");

    expect(sendMessage).toHaveBeenCalledWith("Line 1\nLine 2\nLine 3");
    expect(editor.addToHistory).toHaveBeenCalledWith("Line 1\nLine 2\nLine 3");
    expect(handleCommand).not.toHaveBeenCalled();
    expect(handleBangLine).not.toHaveBeenCalled();
  });
});

describe("createSubmitBurstCoalescer", () => {
  it("coalesces rapid single-line submits into one multiline submit when enabled", () => {
    vi.useFakeTimers();
    const submit = vi.fn();
    let now = 1_000;
    const onSubmit = createSubmitBurstCoalescer({
      submit,
      enabled: true,
      burstWindowMs: 50,
      now: () => now,
    });

    onSubmit("Line 1");
    now += 10;
    onSubmit("Line 2");
    now += 10;
    onSubmit("Line 3");

    expect(submit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("Line 1\nLine 2\nLine 3");
    vi.useRealTimers();
  });

  it("passes through immediately when disabled", () => {
    const submit = vi.fn();
    const onSubmit = createSubmitBurstCoalescer({
      submit,
      enabled: false,
    });

    onSubmit("Line 1");
    onSubmit("Line 2");

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenNthCalledWith(1, "Line 1");
    expect(submit).toHaveBeenNthCalledWith(2, "Line 2");
  });
});

describe("shouldEnableWindowsGitBashPasteFallback", () => {
  it("enables fallback on Windows Git Bash env", () => {
    expect(
      shouldEnableWindowsGitBashPasteFallback({
        platform: "win32",
        env: {
          MSYSTEM: "MINGW64",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe(true);
  });

  it("enables fallback on macOS iTerm", () => {
    expect(
      shouldEnableWindowsGitBashPasteFallback({
        platform: "darwin",
        env: {
          TERM_PROGRAM: "iTerm.app",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe(true);
  });

  it("enables fallback on macOS Terminal.app", () => {
    expect(
      shouldEnableWindowsGitBashPasteFallback({
        platform: "darwin",
        env: {
          TERM_PROGRAM: "Apple_Terminal",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe(true);
  });

  it("disables fallback outside Windows", () => {
    expect(
      shouldEnableWindowsGitBashPasteFallback({
        platform: "linux",
        env: {
          MSYSTEM: "MINGW64",
        } as NodeJS.ProcessEnv,
      }),
    ).toBe(false);
  });
});
