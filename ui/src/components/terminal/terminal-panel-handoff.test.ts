/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  eventGateway,
  panelFixture,
  panelButton,
  togglePanel,
  queueCatalog,
} from "./terminal-panel-lifecycle.test-support.ts";
import { terminalOpenResult } from "./terminal-panel.test-support.ts";

const { create: createTerminal, terminals, mount: mountFixture } = panelFixture(true);

function gatewayFixture() {
  let nextId = 0;
  return eventGateway((method, params) => {
    if (method === "terminal.open") {
      return terminalOpenResult(`session-${++nextId}`);
    }
    if (method === "terminal.attach") {
      const { sessionId } = params as { sessionId: string };
      return { ...terminalOpenResult(sessionId), buffer: "live owner", seq: 10 };
    }
    return method === "terminal.list" ? { sessions: [] } : { ok: true };
  });
}

async function mount(client: TerminalGatewayClient, embedded = true) {
  const panel = mountFixture({ embedded, client });
  await panel.updateComplete;
  await vi.waitFor(() => expect(panel.hostedTabs).toHaveLength(1));
  await vi.waitFor(() => expect(panelButton(panel)?.disabled).toBe(false));
  return panel;
}

function dockButton(panel: HTMLElement) {
  const button = panelButton(panel, '[aria-label="Dock to bottom"]');
  expect(button).not.toBeNull();
  return button!;
}

it("keeps a destination's live PTY beside its detached diagnostic view", async () => {
  const gateway = gatewayFixture();
  const source = await mount(gateway.client);
  gateway.emit("terminal.exit", {
    sessionId: "session-1",
    reason: "detached",
    exitCode: null,
    signal: 15,
  });
  const diagnostic = terminals[0]!;
  const diagnosticHost = createTerminal.mock.calls[0]![0].parent;
  const target = await mount(gateway.client, false);
  togglePanel(target, { open: true, terminalSessionId: "session-1" });
  await vi.waitFor(() => expect(target.hostedTabs).toHaveLength(2));
  await vi.waitFor(() =>
    expect(target.hostedTabs.every((tab) => tab.className === "is-live")).toBe(true),
  );
  const live = terminals[2]!;
  const liveId = target.activeHostedTabId;
  const liveHost = createTerminal.mock.calls[2]![0].parent;
  source.activateTerminalHost();
  await source.updateComplete;
  expect(dockButton(source).disabled).toBe(false);
  dockButton(source).click();
  await vi.waitFor(() => expect(target.hostedTabs).toHaveLength(3));
  expect(target.contains(liveHost)).toBe(true);
  expect(target.contains(diagnosticHost)).toBe(true);
  const diagnosticTab = target.hostedTabs.find((tab) => tab.className === "is-exited");
  expect(diagnosticTab?.statusLabel).toMatch(/detached/i);
  expect(target.activeHostedTabId).toBe(diagnosticTab?.id);
  expect(live.dispose).not.toHaveBeenCalled();
  expect(diagnostic.dispose).not.toHaveBeenCalled();
  togglePanel(target, { open: true, terminalSessionId: "session-1" });
  await vi.waitFor(() => expect(target.activeHostedTabId).toBe(liveId));
  expect(gateway.calls("terminal.attach")).toHaveLength(1);
});

it("disposes an explicitly cancelled diagnostic handoff without a dead attach", async () => {
  const gateway = gatewayFixture();
  const panel = await mount(gateway.client);
  gateway.emit("terminal.exit", { sessionId: "session-1", reason: "process_exit", exitCode: 17 });
  const diagnostic = terminals[0]!;
  dockButton(panel).click();
  expect(panel.hostedTabs).toHaveLength(0);
  expect(sessionStorage.getItem("openclaw.terminal.actions.v1")).toBeNull();
  expect(diagnostic.dispose).not.toHaveBeenCalled();
  panel.closeTerminalPanel();
  expect(diagnostic.dispose).toHaveBeenCalledOnce();
  expect(gateway.calls("terminal.attach")).toEqual([]);
});

it("keeps catalog first-output readiness at its source until output arrives", async () => {
  queueCatalog({ catalogId: "codex", hostId: "gateway:local", threadId: "waiting" });
  const gateway = gatewayFixture();
  const panel = await mount(gateway.client);
  const terminal = terminals[0]!;
  const dock = dockButton(panel);
  expect(panel.hostedTabs[0]?.className).toBe("is-connecting");
  expect(dock.disabled).toBe(true);
  dock.click();
  expect(panel.hostedTabs).toHaveLength(1);
  expect(terminal.dispose).not.toHaveBeenCalled();
  gateway.emit("terminal.data", { sessionId: "session-1", seq: 5, data: "ready" });
  await vi.waitFor(() => expect(dock.disabled).toBe(false));
  expect(panel.hostedTabs[0]?.className).toBe("is-live");
  await vi.advanceTimersByTimeAsync(30_001);
  await panel.updateComplete;
  expect(panel.hostedTabs[0]?.className).toBe("is-live");
  expect(panel.querySelector(".tp-error")).toBeNull();
  expect(terminal.dispose).not.toHaveBeenCalled();
  expect(gateway.calls("terminal.close")).toEqual([]);
});
