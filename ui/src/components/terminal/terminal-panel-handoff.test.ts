/* @vitest-environment jsdom */

import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  createTerminalController,
  createTestTerminalPanel,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  terminalSessionsForTest,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";

const createTerminal: CreateGhosttyTerminalMock = vi.fn();
const tag = defineTestTerminalPanelElement(createTerminal);

function gatewayFixture() {
  let nextId = 0;
  const listeners = new Set<Parameters<TerminalGatewayClient["addEventListener"]>[0]>();
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "terminal.open") {
      return terminalOpenResult(`session-${++nextId}`);
    }
    if (method === "terminal.attach") {
      const { sessionId } = params as { sessionId: string };
      return { ...terminalOpenResult(sessionId), buffer: "live owner", seq: 10 };
    }
    return method === "terminal.list" ? { sessions: [] } : {};
  });
  const client: TerminalGatewayClient = {
    request: request as TerminalGatewayClient["request"],
    forceReconnect: vi.fn(),
    addEventListener: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    client,
    request,
    emit: (event: string, payload: unknown) => {
      for (const listener of listeners) {
        listener({ event, payload });
      }
    },
  };
}

async function mount(client: TerminalGatewayClient) {
  const panel = createTestTerminalPanel(tag);
  panel.client = client;
  panel.available = true;
  document.body.append(panel);
  if (!panel.terminalPanelOpen) {
    panel.toggle();
  }
  // SAFETY: expose the concrete panel's controller solely to inspect lifecycle state.
  const sessions = terminalSessionsForTest(panel);
  await vi.waitFor(() => expect(sessions.tabs).toHaveLength(1));
  await vi.waitFor(() => expect(sessions.booting).toBe(false));
  return { panel, sessions };
}

beforeAll(async () => {
  await import("@openclaw/libterminal/browser");
});
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", createStorageMock());
  vi.stubGlobal("sessionStorage", createStorageMock());
  await i18n.setLocale("en");
  createTerminal.mockImplementation(async () => createTerminalController());
});
afterEach(async () => {
  document.body.replaceChildren();
  await Promise.resolve();
  createTerminal.mockReset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("keeps a destination's live PTY beside its detached diagnostic view", async () => {
  const gateway = gatewayFixture();
  const source = await mount(gateway.client);
  gateway.emit("terminal.exit", {
    sessionId: "session-1",
    reason: "detached",
    exitCode: null,
    signal: 15,
  });
  const diagnostic = source.sessions.tabs[0]!;
  const diagnosticDisposed = vi.spyOn(diagnostic.controller, "dispose");
  const target = await mount(gateway.client);
  await target.sessions.attachSessionById("session-1");
  const live = target.sessions.tabs.find((tab) => tab.gatewaySessionId === "session-1")!;
  const liveDisposed = vi.spyOn(live.controller, "dispose");
  source.sessions.activateHost();
  expect(source.sessions.handoffSessions()).toBe(true);
  target.sessions.activateHost();
  await vi.waitFor(() => expect(target.sessions.tabs).toHaveLength(3));
  expect(target.sessions.tabs).toContain(live);
  expect(target.sessions.tabs).toContain(diagnostic);
  expect(diagnostic).toMatchObject({ status: "exited", exitReason: "detached", exitSignal: 15 });
  expect(target.sessions.activeId).toBe(diagnostic.id);
  expect(liveDisposed).not.toHaveBeenCalled();
  expect(diagnosticDisposed).not.toHaveBeenCalled();
  await target.sessions.attachSessionById("session-1");
  expect(target.sessions.activeId).toBe(live.id);
  expect(
    gateway.request.mock.calls.filter(([method]) => method === "terminal.attach"),
  ).toHaveLength(1);
});

it("disposes an explicitly cancelled diagnostic handoff without a dead attach", async () => {
  const gateway = gatewayFixture();
  const { sessions } = await mount(gateway.client);
  gateway.emit("terminal.exit", { sessionId: "session-1", reason: "process_exit", exitCode: 17 });
  const diagnostic = sessions.tabs[0]!;
  const diagnosticDisposed = vi.spyOn(diagnostic.controller, "dispose");
  expect(sessions.handoffSessions()).toBe(true);
  expect(sessionStorage.getItem("openclaw.terminal.actions.v1")).toBeNull();
  expect(diagnosticDisposed).not.toHaveBeenCalled();
  sessions.cancelPendingActions();
  expect(diagnosticDisposed).toHaveBeenCalledOnce();
  expect(gateway.request.mock.calls.some(([method]) => method === "terminal.attach")).toBe(false);
});

it("keeps catalog first-output readiness at its source until output arrives", async () => {
  sessionStorage.setItem(
    "openclaw.terminal.actions.v1",
    JSON.stringify([
      {
        kind: "catalog",
        agentId: "ops",
        catalog: { catalogId: "codex", hostId: "gateway:local", threadId: "waiting" },
      },
    ]),
  );
  const gateway = gatewayFixture();
  const { sessions } = await mount(gateway.client);
  const tab = sessions.tabs[0]!;
  const disposed = vi.spyOn(tab.controller, "dispose");
  expect(tab.status).toBe("connecting");
  expect(tab.readyTimer).not.toBeNull();
  expect(sessions.canHandoffSessions).toBe(false);
  expect(sessions.handoffSessions()).toBe(false);
  expect(disposed).not.toHaveBeenCalled();
  expect(tab.pendingOpen?.kind).toBe("catalog");
  gateway.emit("terminal.data", { sessionId: "session-1", seq: 5, data: "ready" });
  await vi.waitFor(() => expect(sessions.canHandoffSessions).toBe(true));
  expect(tab.status).toBe("live");
  expect(tab.readyTimer).toBeNull();
});
