import type { CreateGhosttyTerminalOptions } from "@openclaw/libterminal/browser";
import { vi, type Mock } from "vitest";
import { createTerminalController } from "./terminal-controller.test-support.ts";
export { createTerminalController } from "./terminal-controller.test-support.ts";
import { TerminalPanelHost } from "./terminal-panel-registration.ts";
import type { OpenClawTerminalPanel } from "./terminal-panel.ts";

const factories = new Map<string, CreateGhosttyTerminalMock>();
const viewportFactories = new WeakMap<HTMLElement, CreateGhosttyTerminalMock>();

// mock-isolation: Panel lifecycle tests replace WASM emulation at its module boundary.
vi.mock("./terminal-runtime.ts", () => ({
  async createIsolatedGhosttyTerminal(
    options: CreateGhosttyTerminalOptions,
    shouldFocusOnOpen?: () => boolean,
  ) {
    for (
      let container = options.parent.parentElement;
      container;
      container = container.parentElement
    ) {
      const factory = viewportFactories.get(container) ?? factories.get(container.localName);
      if (factory) {
        return factory(options, shouldFocusOnOpen);
      }
    }
    throw new Error("Terminal fixture has not been registered");
  },
}));

/** Direct session-boot fixtures can own a viewport outside a mounted panel. */
export function registerTestTerminalViewport(
  viewport: HTMLElement,
  factory: CreateGhosttyTerminalMock,
): void {
  viewportFactories.set(viewport, factory);
}

export function createTestTerminalPanel(tagName: string): OpenClawTerminalPanel {
  if (!factories.has(tagName)) {
    throw new Error(`Terminal fixture ${tagName} has not been registered`);
  }
  // SAFETY: defineTestTerminalPanelElement registers the real terminal bridge under this tag.
  return document.createElement(tagName) as OpenClawTerminalPanel;
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
  (
    options: CreateOptions,
    shouldFocusOnOpen?: () => boolean,
  ) => Promise<ReturnType<typeof createTerminalController>>
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
