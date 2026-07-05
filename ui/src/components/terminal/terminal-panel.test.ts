/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalGatewayClient } from "./terminal-connection.ts";

type CreateOptions = {
  terminalOptions?: { fontFamily?: string };
  onData?: (bytes: Uint8Array) => void;
  onResize?: (size: { columns: number; rows: number }) => void;
};

const createGhosttyTerminalMock = vi.hoisted(() => vi.fn());

vi.mock("@openclaw/libterminal/browser", () => {
  return { createGhosttyTerminal: createGhosttyTerminalMock };
});

import { OpenClawTerminalPanel } from "./terminal-panel.ts";

describe("OpenClawTerminalPanel", () => {
  afterEach(() => {
    document.body.replaceChildren();
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
});
