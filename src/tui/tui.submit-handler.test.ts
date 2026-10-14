// Covers TUI submit handler behavior for chat input and slash commands.
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { CustomEditor } from "./components/custom-editor.js";
import { editorTheme } from "./theme/theme.js";
import { createTuiCommandHandlersHarness } from "./tui-command-handlers-test-support.js";
import { createSubmitHarness } from "./tui-submit-test-helpers.js";
import {
  createEditorSubmitHandler,
  createSubmitBurstCoalescer,
  shouldEnableWindowsGitBashPasteFallback,
} from "./tui-submit.js";

function createRealEditorSubmitHarness(
  admitMessage?: NonNullable<Parameters<typeof createEditorSubmitHandler>[0]["admitMessage"]>,
) {
  const tui = { requestRender: vi.fn() } as unknown as TUI;
  const editor = new CustomEditor(tui, editorTheme);
  const sendMessage = vi.fn();
  const handleCommand = vi.fn();
  const handleBangLine = vi.fn();
  editor.onSubmit = createEditorSubmitHandler({
    editor,
    handleCommand,
    sendMessage,
    handleBangLine,
    onSubmitError: vi.fn(),
    ...(admitMessage ? { admitMessage } : {}),
  });
  return { editor, sendMessage, handleCommand, handleBangLine };
}

describe("createEditorSubmitHandler", () => {
  it.each([
    { name: "no newer draft", newerDraft: "" },
    { name: "a collapsed paste", newerDraft: "x".repeat(1001) },
  ])("restores rejected slash chat alongside $name", async ({ newerDraft }) => {
    const handlers = createTuiCommandHandlersHarness({ isConnected: false });
    const editor = new CustomEditor({ requestRender: vi.fn() } as unknown as TUI, editorTheme);
    const onSubmitError = vi.fn();
    const submit = createEditorSubmitHandler({
      editor,
      handleCommand: handlers.handleCommand,
      sendMessage: handlers.sendMessage,
      handleBangLine: vi.fn(),
      onSubmitError,
    });
    vi.useFakeTimers();
    const submitBurst = createSubmitBurstCoalescer({ submit, enabled: true });
    editor.onSubmit = submitBurst;
    try {
      const draft = "/tmp/window97-note.txt";
      editor.setText(draft);
      editor.handleInput("\r");
      if (newerDraft) {
        editor.handleInput(`\u001b[200~${newerDraft}\u001b[201~`);
      }
      vi.advanceTimersByTime(50);

      const retained = newerDraft ? `${draft}\n${newerDraft}` : draft;
      expect(editor.getExpandedText()).toBe(retained);
      expect(handlers.sendChat).not.toHaveBeenCalled();
      expect(handlers.addSystem).toHaveBeenCalledExactlyOnceWith(
        "not connected to gateway — message not sent",
      );
      expect(onSubmitError).not.toHaveBeenCalled();

      handlers.state.isConnected = true;
      editor.handleInput("\r");
      vi.advanceTimersByTime(50);
      await Promise.resolve();
      expect(handlers.sendChat).toHaveBeenCalledTimes(1);
      expect(handlers.sendChat).toHaveBeenCalledWith(
        expect.objectContaining({ message: retained }),
      );
      expect(editor.getExpandedText()).toBe("");
    } finally {
      submitBurst.dispose();
      vi.useRealTimers();
    }
  });

  it("routes genuine bang input to local shell and history", () => {
    const { editor, sendMessage, handleBangLine } = createRealEditorSubmitHarness();
    editor.setText("!cmd");

    editor.handleInput("\r");

    expect(handleBangLine).toHaveBeenCalledTimes(1);
    expect(handleBangLine).toHaveBeenCalledWith("!cmd");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("");

    editor.handleInput("\u001b[A");

    expect(editor.getText()).toBe("!cmd");
  });

  it("keeps a newline-suffixed bang paste in chat and omits it from history", () => {
    const input = "!cmd\n";
    const { editor, sendMessage, handleCommand, handleBangLine } = createRealEditorSubmitHarness();
    editor.handleInput(`\u001b[200~${input}\u001b[201~`);

    editor.handleInput("\r");

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(input.trim());
    expect(handleCommand).not.toHaveBeenCalled();
    expect(handleBangLine).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("");

    editor.handleInput("\u001b[A");
    expect(editor.getText()).toBe("");

    editor.handleInput("\r");

    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(input.trim());
    expect(handleCommand).not.toHaveBeenCalled();
    expect(handleBangLine).not.toHaveBeenCalled();
  });

  it("preserves whitespace-prefixed bang routing across a blocked retry", () => {
    const input = "  !cmd";
    const admitMessage = vi
      .fn()
      .mockReturnValueOnce({ status: "blocked", reason: "pending" })
      .mockReturnValueOnce({ status: "allowed" });
    const { editor, sendMessage, handleCommand, handleBangLine } =
      createRealEditorSubmitHarness(admitMessage);
    editor.setText(input);

    editor.handleInput("\r");

    expect(editor.getText()).toBe(input);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(handleCommand).not.toHaveBeenCalled();
    expect(handleBangLine).not.toHaveBeenCalled();

    editor.handleInput("\r");

    expect(admitMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(input.trim());
    expect(handleCommand).not.toHaveBeenCalled();
    expect(handleBangLine).not.toHaveBeenCalled();
    expect(editor.getText()).toBe("");
  });

  it("continues to route slash commands while chat is busy", () => {
    const { editor, handleCommand, sendMessage, onBlockedMessageSubmit, onSubmit } =
      createSubmitHarness({
        admitMessage: () => ({ status: "blocked", reason: "pending" }),
      });

    onSubmit("/abort");

    expect(editor.setText).toHaveBeenCalledWith("");
    expect(handleCommand).toHaveBeenCalledWith("/abort", expect.any(Function));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(onBlockedMessageSubmit).not.toHaveBeenCalled();
  });

  it("reports rejected message handlers", async () => {
    const harness = createSubmitHarness();
    harness.sendMessage.mockRejectedValueOnce(new Error("gateway unavailable"));
    harness.onSubmit("hello");
    await Promise.resolve();
    expect(harness.onSubmitError).toHaveBeenCalledWith("message", expect.any(Error));
  });

  it("reports synchronous submit handler failures", () => {
    const harness = createSubmitHarness();
    harness.handleCommand.mockImplementationOnce(() => {
      throw new Error("command exploded");
    });

    expect(() => harness.onSubmit("/broken")).not.toThrow();
    expect(harness.onSubmitError).toHaveBeenCalledWith("command", expect.any(Error));
  });
});

describe("createSubmitBurstCoalescer", () => {
  it("coalesces rapid single-line submits into one multiline submit when enabled", () => {
    vi.useFakeTimers();
    const submit = vi.fn();
    let now = 1_000;
    const submitBurst = createSubmitBurstCoalescer({
      submit,
      enabled: true,
      burstWindowMs: 50,
      now: () => now,
    });

    submitBurst("Line 1");
    now += 10;
    submitBurst("Line 2");
    now += 10;
    submitBurst("Line 3");

    expect(submit).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("Line 1\nLine 2\nLine 3");
    vi.useRealTimers();
  });

  it.each([false, true])(
    "preserves a collapsed paste across buffered submission (blocked=%s)",
    (initiallyBlocked) => {
      const newerDraft = "x".repeat(1001);
      vi.useFakeTimers();
      const tui = { requestRender: vi.fn() } as unknown as TUI;
      const editor = new CustomEditor(tui, editorTheme);
      const sendMessage = vi.fn();
      let blocked = initiallyBlocked;
      const submit = createEditorSubmitHandler({
        editor,
        handleCommand: vi.fn(),
        sendMessage,
        handleBangLine: vi.fn(),
        onSubmitError: vi.fn(),
        admitMessage: () =>
          blocked ? { status: "blocked", reason: "pending" } : { status: "allowed" },
      });
      const submitBurst = createSubmitBurstCoalescer({ submit, enabled: true });
      editor.onSubmit = submitBurst;
      try {
        editor.setText("submitted message");
        editor.handleInput("\r");
        expect(sendMessage).not.toHaveBeenCalled();

        editor.handleInput(`\u001b[200~${newerDraft}\u001b[201~`);
        expect(editor.getText()).not.toBe(newerDraft);
        expect(editor.getExpandedText()).toBe(newerDraft);

        vi.advanceTimersByTime(50);
        const preservedDraft = initiallyBlocked ? `submitted message\n${newerDraft}` : newerDraft;
        expect(editor.getExpandedText()).toBe(preservedDraft);
        expect(sendMessage.mock.calls).toEqual(initiallyBlocked ? [] : [["submitted message"]]);

        blocked = false;
        editor.handleInput("\r");
        vi.advanceTimersByTime(50);
        expect(sendMessage.mock.calls).toEqual(
          initiallyBlocked ? [[preservedDraft]] : [["submitted message"], [preservedDraft]],
        );
        expect(editor.getExpandedText()).toBe("");
      } finally {
        submitBurst.dispose();
        vi.useRealTimers();
      }
    },
  );

  it("passes through immediately when disabled", () => {
    const submit = vi.fn();
    const submitBurst = createSubmitBurstCoalescer({
      submit,
      enabled: false,
    });

    submitBurst("Line 1");
    submitBurst("Line 2");

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit).toHaveBeenNthCalledWith(1, "Line 1");
    expect(submit).toHaveBeenNthCalledWith(2, "Line 2");
  });

  it("cancels pending and future submissions when disposed", () => {
    vi.useFakeTimers();
    const submit = vi.fn();
    const submitBurst = createSubmitBurstCoalescer({
      submit,
      enabled: true,
      burstWindowMs: 50,
    });

    submitBurst("pending");
    submitBurst.dispose();
    submitBurst.dispose();
    submitBurst("after dispose");
    vi.advanceTimersByTime(50);

    expect(submit).not.toHaveBeenCalled();
    vi.useRealTimers();
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

describe("session transition submit admission", () => {
  it.each([
    { command: "new", capture: "before" },
    { command: "reset", capture: "during" },
  ] as const)(
    "keeps a submit captured $capture /$command blocked across the transition epoch",
    async ({ command, capture }) => {
      vi.useFakeTimers();
      try {
        const transitionResult = createDeferred<{
          ok: true;
          key: string;
          entry: { sessionId: string };
        }>();
        const createSession = vi.fn(() => transitionResult.promise);
        const resetSession = vi.fn(() => transitionResult.promise);
        const applySessionMutationResult = vi.fn().mockReturnValue(true);
        const harness = createTuiCommandHandlersHarness({
          createSession,
          resetSession,
          applySessionMutationResult,
        });
        const editor = {
          getText: vi.fn(() => ""),
          getExpandedText: vi.fn(() => ""),
          setText: vi.fn(),
          addToHistory: vi.fn(),
        };
        const submit = createEditorSubmitHandler({
          editor,
          handleCommand: harness.handleCommand,
          sendMessage: harness.sendMessage,
          handleBangLine: vi.fn(),
          onSubmitError: vi.fn(),
          admitMessage: harness.resolveMessageAdmission,
          onBlockedMessageSubmit: harness.reportBlockedMessageSubmit,
        });
        const bufferedSubmit = createSubmitBurstCoalescer({
          submit,
          captureSnapshot: harness.captureMessageAdmission,
          enabled: true,
          burstWindowMs: 50,
        });

        if (capture === "before") {
          bufferedSubmit("must remain in the editor");
        }
        const transitioning = harness.handleCommand(`/${command}`);
        await Promise.resolve();
        expect(command === "new" ? createSession : resetSession).toHaveBeenCalledOnce();

        if (capture === "during") {
          bufferedSubmit("must remain in the editor");
        }
        transitionResult.resolve({
          ok: true,
          key: command === "new" ? "agent:main:tui-next" : "agent:main:main",
          entry: { sessionId: `session-after-${command}` },
        });
        await transitioning;
        expect(harness.captureMessageAdmission()).toEqual({
          historyLoaded: true,
          sessionTransition: null,
          sessionTransitionEpoch: 2,
        });
        expect(harness.resolveMessageAdmission("live admission is clear")).toEqual({
          status: "allowed",
        });

        vi.advanceTimersByTime(50);

        expect(harness.sendChat).not.toHaveBeenCalled();
        expect(editor.setText).toHaveBeenCalledWith("must remain in the editor");
        expect(harness.addSystem).toHaveBeenCalledWith(
          `session change in progress; wait for /${command} to finish`,
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
