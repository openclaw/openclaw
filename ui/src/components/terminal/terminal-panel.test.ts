/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalGatewayClient } from "./terminal-connection.ts";

type CreateOptions = {
  parent: HTMLElement;
  terminalOptions?: { fontFamily?: string };
  onData?: (bytes: Uint8Array) => void;
  onResize?: (size: { columns: number; rows: number }) => void;
};

const createGhosttyTerminalMock = vi.hoisted(() => vi.fn());

vi.mock("./terminal-runtime.ts", () => {
  return { createIsolatedGhosttyTerminal: createGhosttyTerminalMock };
});

import { OpenClawTerminalPanel } from "./terminal-panel.ts";

describe("OpenClawTerminalPanel", () => {
  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    sessionStorage.clear();
    createGhosttyTerminalMock.mockReset();
  });

  it("opens new sessions for the selected agent", async () => {
    let createOptions: CreateOptions | undefined;
    createGhosttyTerminalMock.mockImplementation(async (options: CreateOptions) => {
      createOptions = options;
      return {
        terminal: {
          cols: 100,
          rows: 30,
          viewportY: 0,
          write: vi.fn(),
          focus: vi.fn(),
        },
        write: vi.fn(),
        fit: vi.fn(),
        dispose: vi.fn(),
      };
    });
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = {
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        return {
          sessionId: "session-1",
          agentId: "ops",
          shell: "/bin/zsh",
          cwd: "/work/ops",
          confined: false,
        } as T;
      },
      addEventListener: () => () => {},
    };
    const panel = document.createElement("openclaw-terminal-panel") as OpenClawTerminalPanel;
    panel.client = client;
    panel.agentId = "ops";
    panel.available = true;
    document.body.append(panel);

    panel.toggle();

    await vi.waitFor(() => {
      expect(requests[0]).toEqual({
        method: "terminal.open",
        params: { agentId: "ops", cols: 100, rows: 30 },
      });
    });
    expect(createOptions?.terminalOptions?.fontFamily).toContain("MesloLGLDZ Nerd Font Mono");
    expect(getComputedStyle(createOptions!.parent).caretColor).toBe("rgba(0, 0, 0, 0)");
    const styles = (OpenClawTerminalPanel.styles as { cssText: string }).cssText;
    expect(styles).toMatch(/\.tp-new\s*\{[^}]*align-self:\s*center/u);
    await vi.waitFor(() => {
      expect(requests).toContainEqual({
        method: "terminal.resize",
        params: { sessionId: "session-1", cols: 100, rows: 30 },
      });
    });

    createOptions?.onData?.(new TextEncoder().encode("pwd\n"));
    createOptions?.onResize?.({ columns: 120, rows: 40 });
    await vi.waitFor(() => {
      expect(requests).toContainEqual({
        method: "terminal.input",
        params: { sessionId: "session-1", data: "pwd\n" },
      });
      expect(requests).toContainEqual({
        method: "terminal.resize",
        params: { sessionId: "session-1", cols: 120, rows: 40 },
      });
    });
  });

  it("fullscreen mode auto-opens without dock chrome and survives last-tab close", async () => {
    createGhosttyTerminalMock.mockImplementation(async () => {
      return {
        terminal: {
          cols: 100,
          rows: 30,
          viewportY: 0,
          write: vi.fn(),
          focus: vi.fn(),
        },
        write: vi.fn(),
        fit: vi.fn(),
        dispose: vi.fn(),
      };
    });
    const requests: Array<{ method: string; params: unknown }> = [];
    const client: TerminalGatewayClient = {
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        return {
          sessionId: "session-1",
          agentId: "ops",
          shell: "/bin/zsh",
          cwd: "/work/ops",
          confined: false,
        } as T;
      },
      addEventListener: () => () => {},
    };
    const panel = document.createElement("openclaw-terminal-panel") as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    panel.fullscreen = true;
    document.body.append(panel);

    // No toggle: the terminal-only document opens its session on mount.
    await vi.waitFor(() => {
      expect(requests.some((entry) => entry.method === "terminal.open")).toBe(true);
    });
    await panel.updateComplete;
    const section = panel.renderRoot.querySelector(".tp");
    expect(section?.classList.contains("tp--fullscreen")).toBe(true);
    expect(panel.renderRoot.querySelector(".tp-resizer")).toBeNull();
    expect(panel.renderRoot.querySelector(".tp-actions")).toBeNull();

    // Closing the last tab must keep the panel (with its "+" button) rendered —
    // a fullscreen document has no toggle to bring a closed panel back.
    (panel.renderRoot.querySelector(".tp-tab__close") as HTMLElement).click();
    await panel.updateComplete;
    expect(requests.some((entry) => entry.method === "terminal.close")).toBe(true);
    expect(panel.renderRoot.querySelector(".tp")).not.toBeNull();
    expect(panel.renderRoot.querySelector(".tp-new")).not.toBeNull();
  });

  it("opens a fresh terminal after the last tab is closed", async () => {
    const controllers = Array.from({ length: 2 }, () => ({
      terminal: {
        cols: 100,
        rows: 30,
        viewportY: 0,
        write: vi.fn(),
        focus: vi.fn(),
      },
      write: vi.fn(),
      fit: vi.fn(),
      dispose: vi.fn(),
    }));
    createGhosttyTerminalMock
      .mockResolvedValueOnce(controllers[0])
      .mockResolvedValueOnce(controllers[1]);

    const requests: Array<{ method: string; params: unknown }> = [];
    let listener: ((event: { event: string; payload: unknown }) => void) | undefined;
    let openCount = 0;
    const client: TerminalGatewayClient = {
      request: async <T>(method: string, params?: unknown) => {
        requests.push({ method, params });
        if (method === "terminal.open") {
          openCount += 1;
          return {
            sessionId: `session-${openCount}`,
            agentId: "main",
            shell: "/bin/bash",
            cwd: "/work",
            confined: false,
          } as T;
        }
        return {} as T;
      },
      addEventListener: (nextListener) => {
        listener = nextListener;
        return () => {
          if (listener === nextListener) {
            listener = undefined;
          }
        };
      },
    };
    const panel = document.createElement("openclaw-terminal-panel") as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);

    panel.toggle();
    await vi.waitFor(() => {
      expect(requests.filter((entry) => entry.method === "terminal.open")).toHaveLength(1);
    });

    const staleOutput = "CLOSE_RESET_SENTINEL";
    listener?.({
      event: "terminal.data",
      payload: { sessionId: "session-1", seq: 0, data: staleOutput },
    });
    expect(new TextDecoder().decode(controllers[0].write.mock.calls[0]?.[0])).toBe(staleOutput);

    await panel.updateComplete;
    (panel.renderRoot.querySelector(".tp-tab__close") as HTMLElement).click();
    await vi.waitFor(() => {
      expect(requests).toContainEqual({
        method: "terminal.close",
        params: { sessionId: "session-1" },
      });
    });
    expect(controllers[0].dispose).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem("openclaw.terminal.sessions.v1")).toBe("[]");

    panel.toggle();
    await vi.waitFor(() => {
      expect(requests.filter((entry) => entry.method === "terminal.open")).toHaveLength(2);
    });
    expect(requests.some((entry) => entry.method === "terminal.attach")).toBe(false);
    expect(createGhosttyTerminalMock).toHaveBeenCalledTimes(2);
    expect(controllers[1].write).not.toHaveBeenCalled();
  });
});
