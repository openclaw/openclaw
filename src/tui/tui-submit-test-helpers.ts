import { vi } from "vitest";
import { createEditorSubmitHandler } from "./tui.js";

type MockFn = ReturnType<typeof vi.fn>;

export type SubmitHarness = {
  editor: {
    setText: MockFn;
    addToHistory: MockFn;
  };
  handleCommand: MockFn;
  sendMessage: MockFn;
  handleBangLine: MockFn;
  isRunActive: MockFn;
  onSubmitBlocked: MockFn;
  onSubmit: (text: string) => void;
};

export function createSubmitHarness(opts?: { isRunActive?: () => boolean }): SubmitHarness {
  const editor = {
    setText: vi.fn(),
    addToHistory: vi.fn(),
  };
  const handleCommand = vi.fn();
  const sendMessage = vi.fn();
  const handleBangLine = vi.fn();
  const isRunActive = vi.fn().mockImplementation(opts?.isRunActive ?? (() => false));
  const onSubmitBlocked = vi.fn();
  const onSubmit = createEditorSubmitHandler({
    editor,
    handleCommand,
    sendMessage,
    handleBangLine,
    isRunActive,
    onSubmitBlocked,
  });
  return {
    editor,
    handleCommand,
    sendMessage,
    handleBangLine,
    isRunActive,
    onSubmitBlocked,
    onSubmit,
  };
}
