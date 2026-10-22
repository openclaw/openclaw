import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { CustomEditor } from "./components/custom-editor.js";
import { editorTheme } from "./theme/theme.js";
import { createTuiCommandHandlersHarness } from "./tui-command-handlers-test-support.js";
import { expectUnused, expectCall } from "./tui-handler-test-support.js";
import {
  clearPendingSubmit,
  clearPendingSubmitDraft,
  type TuiPendingSubmit,
} from "./tui-submit-state.js";
import { createSubmitHarness } from "./tui-submit-test-helpers.js";
import {
  createEditorSubmitHandler,
  createSubmitBurstCoalescer,
  shouldEnableWindowsGitBashPasteFallback,
} from "./tui-submit.js";

function createRealEditorSubmitHarness(
  admitMessage?: NonNullable<Parameters<typeof createEditorSubmitHandler>[0]["admitMessage"]>,
  overrides: Partial<Parameters<typeof createEditorSubmitHandler>[0]> = {},
) {
  const editor = new CustomEditor({ requestRender: vi.fn() } as unknown as TUI, editorTheme);
  const sendMessage = vi.fn();
  const handleCommand = vi.fn();
  const handleBangLine = vi.fn();
  const onSubmitError = vi.fn();
  const submit = createEditorSubmitHandler({
    editor,
    handleCommand,
    sendMessage,
    handleBangLine,
    onSubmitError,
    ...(admitMessage ? { admitMessage } : {}),
    ...overrides,
  });
  editor.onSubmit = submit;
  return { editor, sendMessage, handleCommand, handleBangLine, onSubmitError, submit };
}

type BurstParams = Parameters<typeof createSubmitBurstCoalescer>[0];
function bufferSubmit(
  submit: BurstParams["submit"],
  options: Omit<BurstParams, "submit" | "enabled"> = {},
) {
  vi.useFakeTimers();
  const burst = createSubmitBurstCoalescer({ submit, enabled: true, ...options });
  onTestFinished(() => {
    burst.dispose();
    vi.useRealTimers();
  });
  return burst;
}

describe("submit admission and ownership", () => {
  it.each([
    ["idle", true, null, "hello", { status: "allowed" }],
    ["disconnected", false, null, "hello", { status: "blocked", reason: "disconnected" }],
    [
      "sending",
      true,
      { phase: "sending", runId: "run-local", draftText: "hello" },
      "another",
      { status: "blocked", reason: "pending" },
    ],
    [
      "stop accepted run",
      true,
      { phase: "accepted", runId: "run-accepted", draftText: null },
      "please stop",
      { status: "allowed" },
    ],
  ] as const)(
    "resolves admission while %s",
    (_name, isConnected, pendingSubmit, message, expected) => {
      const h = createTuiCommandHandlersHarness({
        isConnected,
        pendingSubmit,
        historyLoaded: true,
      });
      expect(h.resolveMessageAdmission(message)).toEqual(expected);
    },
  );

  it.each([
    ["sending", clearPendingSubmitDraft, "run-sending", "run-sending"],
    ["accepted", clearPendingSubmit, "run-current", "run-other"],
  ] as const)("preserves %s pending ownership", (phase, clear, owner, runId) => {
    const state: { pendingSubmit: TuiPendingSubmit | null } = {
      pendingSubmit: { phase, runId: owner, draftText: "hello" },
    };
    expect(clear(state, runId)).toBe(false);
    expect(state.pendingSubmit).toEqual({ phase, runId: owner, draftText: "hello" });
  });

  it.each([
    [false, "not connected to gateway — message not sent"],
    [true, "local runtime not ready — message not sent"],
  ] as const)("reports disconnected runtime (local=%s)", async (local, message) => {
    const h = createTuiCommandHandlersHarness({ isConnected: false, opts: { local } });
    await h.sendMessage("hello");
    expect(h.addSystem).toHaveBeenCalledWith(message);
  });
});

describe("createEditorSubmitHandler", () => {
  it.each([
    { name: "no newer draft", newerDraft: "" },
    { name: "a collapsed paste", newerDraft: "x".repeat(1001) },
  ])("restores rejected slash chat alongside $name", async ({ newerDraft }) => {
    const handlers = createTuiCommandHandlersHarness({ isConnected: false });
    const { editor, submit, onSubmitError } = createRealEditorSubmitHarness(undefined, {
      handleCommand: handlers.handleCommand,
      sendMessage: handlers.sendMessage,
    });
    const submitBurst = bufferSubmit(submit);
    editor.onSubmit = submitBurst;
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
    expectCall(handlers.addSystem, ["not connected to gateway — message not sent"], "once");
    expect(onSubmitError).not.toHaveBeenCalled();
    handlers.state.isConnected = true;
    editor.handleInput("\r");
    vi.advanceTimersByTime(50);
    await Promise.resolve();
    expectCall(handlers.sendChat, [expect.objectContaining({ message: retained })], "once");
    expect(editor.getExpandedText()).toBe("");
  });

  it("routes genuine bang input to local shell and history", () => {
    const { editor, sendMessage, handleBangLine } = createRealEditorSubmitHarness();
    editor.setText("!cmd");
    editor.handleInput("\r");
    expect(handleBangLine).toHaveBeenCalledExactlyOnceWith("!cmd");
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
    expectUnused(handleCommand, handleBangLine);
    expect(editor.getText()).toBe("");
    editor.handleInput("\u001b[A");
    expect(editor.getText()).toBe("");
    editor.handleInput("\r");
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(input.trim());
    expectUnused(handleCommand, handleBangLine);
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
    expectUnused(sendMessage, handleCommand, handleBangLine);
    editor.handleInput("\r");
    expect(admitMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(input.trim());
    expectUnused(handleCommand, handleBangLine);
    expect(editor.getText()).toBe("");
  });

  it("continues to route slash commands while chat is busy", () => {
    const { editor, handleCommand, sendMessage, onBlockedMessageSubmit, onSubmit } =
      createSubmitHarness({ admitMessage: () => ({ status: "blocked", reason: "pending" }) });
    onSubmit("/abort");
    expect(editor.setText).toHaveBeenCalledWith("");
    expect(handleCommand).toHaveBeenCalledWith("/abort", expect.any(Function));
    expectUnused(sendMessage, onBlockedMessageSubmit);
  });

  it.each(["message", "command"] as const)("reports %s handler failures", async (action) => {
    const harness = createSubmitHarness();
    if (action === "message") {
      harness.sendMessage.mockRejectedValueOnce(new Error("gateway unavailable"));
    } else {
      harness.handleCommand.mockImplementationOnce(() => {
        throw new Error("command exploded");
      });
    }
    expect(() => harness.onSubmit(action === "message" ? "hello" : "/broken")).not.toThrow();
    await Promise.resolve();
    expect(harness.onSubmitError).toHaveBeenCalledWith(action, expect.any(Error));
  });
});

describe("createSubmitBurstCoalescer", () => {
  it("coalesces rapid single-line submits into one multiline submit when enabled", () => {
    const submit = vi.fn();
    const submitBurst = bufferSubmit(submit);
    submitBurst("Line 1");
    vi.advanceTimersByTime(10);
    submitBurst("Line 2");
    vi.advanceTimersByTime(10);
    submitBurst("Line 3");
    expect(submit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(submit).toHaveBeenCalledExactlyOnceWith("Line 1\nLine 2\nLine 3");
  });

  it.each([false, true])(
    "preserves a collapsed paste across buffered submission (blocked=%s)",
    (initiallyBlocked) => {
      const newerDraft = "x".repeat(1001);
      let blocked = initiallyBlocked;
      const { editor, sendMessage, submit } = createRealEditorSubmitHarness(() =>
        blocked ? { status: "blocked", reason: "pending" } : { status: "allowed" },
      );
      const submitBurst = bufferSubmit(submit);
      editor.onSubmit = submitBurst;
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
    },
  );

  it("passes through immediately when disabled", () => {
    const submit = vi.fn();
    const submitBurst = createSubmitBurstCoalescer({ submit, enabled: false });
    submitBurst("Line 1");
    submitBurst("Line 2");
    expect(submit.mock.calls).toEqual([["Line 1"], ["Line 2"]]);
  });

  it("cancels pending and future submissions when disposed", () => {
    const submit = vi.fn();
    const submitBurst = bufferSubmit(submit);
    submitBurst("pending");
    submitBurst.dispose();
    submitBurst.dispose();
    submitBurst("after dispose");
    vi.advanceTimersByTime(50);
    expect(submit).not.toHaveBeenCalled();
  });
});

it.each([
  { platform: "win32", env: { MSYSTEM: "MINGW64" }, enabled: true },
  { platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal" }, enabled: true },
  { platform: "linux", env: { MSYSTEM: "MINGW64" }, enabled: false },
])("detects paste fallback for $platform/$env", ({ platform, env, enabled }) => {
  expect(shouldEnableWindowsGitBashPasteFallback({ platform, env })).toBe(enabled);
});

it.each([
  { command: "new", capture: "before" },
  { command: "reset", capture: "during" },
] as const)(
  "keeps a submit captured $capture /$command blocked across the transition epoch",
  async ({ command, capture }) => {
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
    const { editor, handleBangLine, onSubmitError } = createSubmitHarness();
    const submit = createEditorSubmitHandler({
      editor,
      handleCommand: harness.handleCommand,
      sendMessage: harness.sendMessage,
      handleBangLine,
      onSubmitError,
      admitMessage: harness.resolveMessageAdmission,
      onBlockedMessageSubmit: harness.reportBlockedMessageSubmit,
    });
    const bufferedSubmit = bufferSubmit(submit, {
      captureSnapshot: harness.captureMessageAdmission,
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
    expectCall(harness.addSystem, [`session change in progress; wait for /${command} to finish`]);
  },
);
