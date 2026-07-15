/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import { OpenClawTerminalPanel } from "./terminal-panel.ts";

type CreateOptions = {
  parent: HTMLElement;
  terminalOptions?: { fontFamily?: string };
  onData?: (bytes: Uint8Array) => void;
  onResize?: (size: { columns: number; rows: number }) => void;
};

function createTerminalController() {
  return {
    readOnly: false,
    terminal: {
      cols: 100,
      rows: 30,
      viewportY: 0,
      write: vi.fn(),
      focus: vi.fn(),
      reset: vi.fn(),
      paste: vi.fn(),
    },
    write: vi.fn(),
    fit: vi.fn(),
    resize: vi.fn(),
    setReadOnly: vi.fn(),
    attach: vi.fn(),
    dispose: vi.fn(),
  };
}

type TerminalFactory = typeof import("./terminal-runtime.ts").createIsolatedGhosttyTerminal;
type CreateGhosttyTerminalMock = Mock<
  (options: CreateOptions) => Promise<ReturnType<typeof createTerminalController>>
>;

const createGhosttyTerminalMock: CreateGhosttyTerminalMock = vi.fn();
const TERMINAL_PANEL_ELEMENT_NAME = `test-openclaw-terminal-panel-upload-${crypto.randomUUID()}`;

class TestTerminalPanel extends OpenClawTerminalPanel {
  protected override createTerminal = createGhosttyTerminalMock as unknown as TerminalFactory;
}

customElements.define(TERMINAL_PANEL_ELEMENT_NAME, TestTerminalPanel);

function terminalUploadFile(name: string, content: string): File {
  const file = new File([content], name);
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode(content).buffer,
  });
  return file;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("OpenClawTerminalPanel upload lifecycle", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    await i18n.setLocale("en");
  });

  afterEach(async () => {
    document.body.replaceChildren();
    createGhosttyTerminalMock.mockReset();
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  it("cancels a pending upload when its terminal tab closes", async () => {
    const controller = createTerminalController();
    createGhosttyTerminalMock.mockResolvedValue(controller);
    const pendingUpload = deferred<{ path: string; size: number }>();
    let uploadSignal: AbortSignal | undefined;
    const client: TerminalGatewayClient = {
      request: async <T>(method: string, _params?: unknown, options?: { signal?: AbortSignal }) => {
        if (method === "terminal.open") {
          return {
            sessionId: "session-1",
            agentId: "ops",
            shell: "/bin/zsh",
            cwd: "/work/ops",
            confined: false,
          } as T;
        }
        if (method === "terminal.upload") {
          uploadSignal = options?.signal;
          return (await pendingUpload.promise) as T;
        }
        return {} as T;
      },
      addEventListener: () => () => {},
    };
    const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
    panel.toggle();
    await vi.waitFor(() => {
      expect(panel.renderRoot.querySelector<HTMLButtonElement>(".tp-upload")?.disabled).toBe(false);
    });

    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: {
        types: ["Files"],
        files: [terminalUploadFile("archive.zip", "zip")],
        dropEffect: "none",
      },
    });
    panel.renderRoot.querySelector(".tp-viewport")?.dispatchEvent(drop);
    await vi.waitFor(() => {
      expect(panel.renderRoot.querySelector(".tp-upload-card")?.textContent).toContain(
        "Uploading 1 of 1",
      );
    });

    panel.renderRoot.querySelector<HTMLButtonElement>(".tp-tab__close")?.click();
    await vi.waitFor(() => {
      expect(uploadSignal?.aborted).toBe(true);
      expect(panel.renderRoot.querySelector(".tp-upload-card")).toBeNull();
    });

    pendingUpload.reject(new Error("terminal closed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.terminal.paste).not.toHaveBeenCalled();
    expect(panel.renderRoot.querySelector(".tp-upload-card")).toBeNull();
  });
});
