/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import { mountPanel, panelTestStorage } from "./terminal-panel-lifecycle.test-support.ts";
import {
  createTerminalController,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";

const createTerminal: CreateGhosttyTerminalMock = vi.fn();
const tag = defineTestTerminalPanelElement(createTerminal);
const storageKey = "openclaw.terminal.panel.v1";
panelTestStorage(createTerminal);

function savePlacement(dock = "bottom") {
  localStorage.setItem(storageKey, JSON.stringify({ open: true, dock, height: 320, width: 520 }));
}

it.each(["bottom", "main"])(
  "suppresses and restores %s without overwriting its preference",
  async (dock) => {
    savePlacement(dock);
    const panel = mountPanel(tag, { available: true }, false);
    await panel.updateComplete;
    const selector = dock === "main" ? ".tp--main" : ".tp";
    expect(panel.querySelector(selector)).not.toBeNull();
    panel.suppressed = true;
    await waitForFast(() => expect(panel.querySelector(".tp")).toBeNull());
    expect(document.documentElement.style.getPropertyValue("--oc-terminal-reserve-bottom")).toBe(
      "0px",
    );
    expect(JSON.parse(localStorage.getItem(storageKey) ?? "{}")).toMatchObject({
      open: true,
      dock,
    });
    panel.suppressed = false;
    await waitForFast(() => expect(panel.querySelector(selector)).not.toBeNull());
  },
);

it.each([false, true])(
  "defers suppressed startup until available (initially available=%s)",
  async (available) => {
    savePlacement();
    createTerminal.mockResolvedValue(createTerminalController());
    const requests: string[] = [];
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string) => {
        requests.push(method);
        return (method === "terminal.open" ? terminalOpenResult("session-1") : {}) as T;
      },
      addEventListener: () => () => {},
    };
    const panel = mountPanel(tag, { client, available, suppressed: true }, false);
    await panel.updateComplete;
    if (!available) {
      panel.available = true;
      await panel.updateComplete;
    }
    await Promise.resolve();
    expect(panel.terminalPanelOpen).toBe(false);
    expect(requests).not.toContain("terminal.open");
    panel.suppressed = false;
    await panel.updateComplete;
    await waitForFast(() => expect(requests).toContain("terminal.open"));
    expect(panel.terminalPanelOpen).toBe(true);
  },
);
