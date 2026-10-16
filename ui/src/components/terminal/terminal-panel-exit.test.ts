/* @vitest-environment jsdom */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  createTerminalController,
  createTestTerminalPanel,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";

type Exit = { reason?: string; exitCode: number | null; signal?: number | null; error?: string };
const normalExit: Exit = { reason: "process_exit", exitCode: 0, signal: null };
const createTerminal: CreateGhosttyTerminalMock = vi.fn();
const tag = defineTestTerminalPanelElement(createTerminal);

async function mount(options: { fullscreen?: boolean; earlyExit?: Exit } = {}) {
  const controllers: ReturnType<typeof createTerminalController>[] = [];
  createTerminal.mockImplementation(async () => {
    const controller = createTerminalController();
    controllers.push(controller);
    return controller;
  });
  const listeners = new Set<Parameters<TerminalGatewayClient["addEventListener"]>[0]>();
  const emit = (event: string, payload: unknown) => {
    for (const listener of listeners) {
      listener({ event, payload });
    }
  };
  let sequence = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "terminal.open") {
      const sessionId = `session-${++sequence}`;
      if (options.earlyExit) {
        emit("terminal.exit", { sessionId, ...options.earlyExit });
      }
      return terminalOpenResult(sessionId);
    }
    return method === "terminal.list" ? { sessions: [] } : {};
  });
  const panel = createTestTerminalPanel(tag);
  panel.client = {
    forceReconnect: vi.fn(),
    request: request as TerminalGatewayClient["request"],
    addEventListener: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  panel.available = true;
  panel.fullscreen = options.fullscreen ?? false;
  document.body.append(panel);
  if (!panel.fullscreen) {
    panel.toggle();
  }
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("terminal.open", expect.anything(), expect.anything()),
  );
  await waitForFast(() => expect(panel.renderRoot.querySelector(".tp-connecting")).toBeNull());
  await panel.updateComplete;
  return { panel, controllers, request, emit };
}

describe("terminal process exit", () => {
  beforeAll(async () => {
    await import("@openclaw/libterminal/browser");
  });
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    await i18n.setLocale("en");
  });
  afterEach(async () => {
    document.body.replaceChildren();
    await Promise.resolve();
    createTerminal.mockReset();
    vi.unstubAllGlobals();
  });

  it("closes the last normally exited shell without another close RPC and reopens fresh", async () => {
    const { panel, controllers, request, emit } = await mount();
    emit("terminal.exit", { sessionId: "session-1", ...normalExit });
    await panel.updateComplete;
    expect(panel.hostedTabs).toEqual([]);
    expect(panel.terminalPanelOpen).toBe(false);
    expect(controllers[0]!.dispose).toHaveBeenCalledOnce();
    expect(request.mock.calls.some(([method]) => method === "terminal.close")).toBe(false);
    expect(JSON.parse(sessionStorage.getItem("openclaw.terminal.sessions.v1") ?? "[]")).toEqual([]);
    expect(document.documentElement.style.getPropertyValue("--oc-terminal-reserve-bottom")).toBe(
      "0px",
    );
    panel.toggle();
    await waitForFast(() => expect(panel.hostedTabs[0]?.className).toBe("is-live"));
    expect(request.mock.calls.filter(([method]) => method === "terminal.open")).toHaveLength(2);
  });

  it("selects the remaining shell instead of closing the panel", async () => {
    const { panel, emit } = await mount();
    const remaining = panel.activeHostedTabId;
    panel.handleToggleRequest(
      new CustomEvent("openclaw:terminal-toggle", { detail: { newSession: true } }),
    );
    await waitForFast(() => expect(panel.hostedTabs).toHaveLength(2));
    await waitForFast(() => expect(panel.hostedTabs[1]?.className).toBe("is-live"));
    emit("terminal.exit", { sessionId: "session-2", ...normalExit });
    await panel.updateComplete;
    expect(panel.hostedTabs).toHaveLength(1);
    expect(panel.activeHostedTabId).toBe(remaining);
    expect(panel.terminalPanelOpen).toBe(true);
  });

  it.each([
    { reason: "process_exit", exitCode: 7 },
    { reason: "process_exit", exitCode: 0, signal: 15 },
    { reason: "process_exit", exitCode: null },
    { reason: "error", exitCode: 0, error: "PTY failed" },
    { reason: "process_exit", exitCode: 0, error: "Output failed" },
    { reason: "detached", exitCode: 0 },
    { reason: "disconnected", exitCode: null },
    { reason: "closed", exitCode: 0 },
    { exitCode: 0 },
  ] satisfies Exit[])(
    "preserves output for $reason / $exitCode / $signal / $error",
    async (exit) => {
      const { panel, controllers, emit } = await mount();
      const data = "Diagnostic output\r\n";
      emit("terminal.data", { sessionId: "session-1", seq: data.length, data });
      emit("terminal.exit", { sessionId: "session-1", ...exit });
      await panel.updateComplete;
      expect(panel.hostedTabs[0]?.className).toBe("is-exited");
      expect(panel.terminalPanelOpen).toBe(true);
      expect(controllers[0]!.dispose).not.toHaveBeenCalled();
      expect(controllers[0]!.write).toHaveBeenCalledWith(new TextEncoder().encode(data));
    },
  );

  it("keeps the fullscreen new-shell control reachable after a normal exit", async () => {
    const { panel, emit } = await mount({ fullscreen: true });
    emit("terminal.exit", { sessionId: "session-1", ...normalExit });
    await panel.updateComplete;
    expect(panel.hostedTabs).toEqual([]);
    expect(panel.terminalPanelOpen).toBe(true);
    expect(panel.renderRoot.querySelector(".tabstrip-new")).not.toBeNull();
  });

  it("does not resurrect an early normal exit or open a replacement shell", async () => {
    const { panel, request } = await mount({ earlyExit: normalExit });
    expect(panel.hostedTabs).toEqual([]);
    expect(panel.terminalPanelOpen).toBe(false);
    expect(request.mock.calls.filter(([method]) => method === "terminal.open")).toHaveLength(1);
  });
});
