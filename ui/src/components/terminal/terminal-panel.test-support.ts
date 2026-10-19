import type { Mock } from "vitest";
import { createTerminalController } from "./terminal-controller.test-support.ts";
export { createTerminalController } from "./terminal-controller.test-support.ts";
import { TerminalPanelHost } from "./terminal-panel-registration.ts";
import type { OpenClawTerminalPanel } from "./terminal-panel.ts";

const factories = new Map<string, CreateGhosttyTerminalMock>();

export function createTestTerminalPanel(tagName: string): OpenClawTerminalPanel {
  const factory = factories.get(tagName);
  if (!factory) {
    throw new Error(`Terminal fixture ${tagName} has not been registered`);
  }
  const element = document.createElement(tagName) as OpenClawTerminalPanel;
  element.createTerminalController =
    factory as unknown as OpenClawTerminalPanel["createTerminalController"];
  return element;
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
  tagName = "openclaw-terminal-panel",
): string {
  factories.set(tagName, createGhosttyTerminalMock);
  if (tagName !== "openclaw-terminal-panel") {
    const Element: CustomElementConstructor = TerminalPanelHost.Element;
    customElements.define(tagName, class extends Element {});
  }
  return tagName;
}
