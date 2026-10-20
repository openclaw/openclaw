/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  eventGateway,
  mountPanel,
  panelTestStorage,
  togglePanel,
} from "./terminal-panel-lifecycle.test-support.ts";
import {
  createTerminalController,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";

type Exit = { reason?: string; exitCode: number | null; signal?: number | null; error?: string };
const normalExit: Exit = { reason: "process_exit", exitCode: 0, signal: null };
const createTerminal: CreateGhosttyTerminalMock = vi.fn();
const tag = defineTestTerminalPanelElement(createTerminal);
panelTestStorage(createTerminal);

async function mount(options: { fullscreen?: boolean; earlyExit?: Exit } = {}) {
  const controllers: ReturnType<typeof createTerminalController>[] = [];
  createTerminal.mockImplementation(async () => {
    const controller = createTerminalController();
    controllers.push(controller);
    return controller;
  });
  let sequence = 0;
  const { client, request, emit } = eventGateway((method) => {
    if (method === "terminal.open") {
      const sessionId = `session-${++sequence}`;
      if (options.earlyExit) {
        emit("terminal.exit", { sessionId, ...options.earlyExit });
      }
      return terminalOpenResult(sessionId);
    }
    return method === "terminal.list" ? { sessions: [] } : { ok: true };
  });
  const panel = mountPanel(
    tag,
    {
      client,
      available: true,
      fullscreen: options.fullscreen ?? false,
    },
    !options.fullscreen,
  );
  await waitForFast(() =>
    expect(request).toHaveBeenCalledWith("terminal.open", expect.anything(), expect.anything()),
  );
  await waitForFast(() => expect(panel.querySelector(".tp-connecting")).toBeNull());
  await panel.updateComplete;
  return { panel, controllers, request, emit };
}

describe("terminal process exit", () => {
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
    togglePanel(panel, { newSession: true });
    await waitForFast(() => expect(panel.hostedTabs).toHaveLength(2));
    await waitForFast(() => expect(panel.hostedTabs[1]?.className).toBe("is-live"));
    emit("terminal.exit", { sessionId: "session-2", ...normalExit });
    await panel.updateComplete;
    expect(panel.hostedTabs).toHaveLength(1);
    expect(panel.activeHostedTabId).toBe(remaining);
    expect(panel.terminalPanelOpen).toBe(true);
  });

  it("allows removing an exited diagnostic tab while offline", async () => {
    const { panel, request, emit } = await mount();
    emit("terminal.exit", { sessionId: "session-1", reason: "error", exitCode: 7 });
    await panel.updateComplete;
    panel.gatewayConnected = false;
    await panel.updateComplete;
    expect(panel.hostedTabs[0]?.closeDisabled).toBe(false);
    const close = panel.querySelector<HTMLButtonElement>(".tabstrip-tab__close")!;
    expect(close.disabled).toBe(false);
    close.click();
    await panel.updateComplete;
    expect(panel.hostedTabs).toEqual([]);
    expect(request.mock.calls.some(([method]) => method === "terminal.close")).toBe(false);
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
    expect(panel.querySelector(".tabstrip-new")).not.toBeNull();
  });

  it("does not resurrect an early normal exit or open a replacement shell", async () => {
    const { panel, request } = await mount({ earlyExit: normalExit });
    expect(panel.hostedTabs).toEqual([]);
    expect(panel.terminalPanelOpen).toBe(false);
    expect(request.mock.calls.filter(([method]) => method === "terminal.open")).toHaveLength(1);
  });
});
