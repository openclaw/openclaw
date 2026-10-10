import type { Mock } from "vitest";
import { createTerminalController } from "./terminal-controller.test-support.ts";
export { createTerminalController } from "./terminal-controller.test-support.ts";
import { defineTerminalPanelElement } from "./terminal-panel-registration.ts";
import type { TerminalPanelSessionController } from "./terminal-panel-session-controller.ts";
import { TerminalPanelController } from "./terminal-panel.ts";

const controllers = new WeakMap<HTMLElement, TerminalPanelController>();

export function terminalSessionsForTest(element: HTMLElement): TerminalPanelSessionController {
  const controller = controllers.get(element);
  if (!controller) {
    throw new Error("Terminal panel fixture is not mounted");
  }
  return (controller as unknown as { terminalSessions: TerminalPanelSessionController })
    .terminalSessions;
}

export type CreateOptions = {
  parent: HTMLElement;
  readOnly?: boolean;
  terminalOptions?: {
    fontSize?: number;
    fontFamily?: string;
    theme?: { background?: string; foreground?: string };
  };
  onData?: (bytes: Uint8Array) => void;
  onResize?: (size: { columns: number; rows: number }) => void;
};

export type CreateGhosttyTerminalMock = Mock<
  (options: CreateOptions) => Promise<ReturnType<typeof createTerminalController>>
>;

export function terminalOpenResult(sessionId: string) {
  return {
    sessionId,
    agentId: "ops",
    shell: "/bin/zsh",
    cwd: "/work/ops",
    confined: false,
  };
}

export function defineTestTerminalPanelElement(
  createGhosttyTerminalMock: CreateGhosttyTerminalMock,
  tagName = `test-openclaw-terminal-panel-${crypto.randomUUID()}`,
): string {
  type TerminalFactory = typeof import("./terminal-runtime.ts").createIsolatedGhosttyTerminal;

  defineTerminalPanelElement(tagName, (element) => {
    const controller = new TerminalPanelController(element);
    Object.assign(element, {
      createTerminalController: createGhosttyTerminalMock as unknown as TerminalFactory,
    });
    controllers.set(element, controller);
    return controller;
  });
  return tagName;
}
