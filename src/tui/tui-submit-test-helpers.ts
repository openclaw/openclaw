// Provides test helpers for TUI submit handler scenarios.
import { vi } from "vitest";
import type { TuiChatSubmitAdmission } from "./tui-submit-state.js";
import { createEditorSubmitHandler } from "./tui-submit.js";

/** Creates editor/command/message mocks wired to the real submit handler. */
export function createSubmitHarness(params?: {
  admitMessage?: (value: string) => TuiChatSubmitAdmission;
}) {
  const editor = {
    getExpandedText: vi.fn(() => ""),
    setText: vi.fn(),
    addToHistory: vi.fn(),
  };
  const handleCommand = vi.fn();
  const sendMessage = vi.fn();
  const handleBangLine = vi.fn();
  const admitMessage = vi.fn(params?.admitMessage ?? (() => ({ status: "allowed" }) as const));
  const onBlockedMessageSubmit = vi.fn();
  const onSubmitError = vi.fn();
  const onSubmit = createEditorSubmitHandler({
    editor,
    handleCommand,
    sendMessage,
    handleBangLine,
    onSubmitError,
    admitMessage,
    onBlockedMessageSubmit,
  });
  return {
    editor,
    handleCommand,
    sendMessage,
    handleBangLine,
    onBlockedMessageSubmit,
    onSubmitError,
    onSubmit,
  };
}
