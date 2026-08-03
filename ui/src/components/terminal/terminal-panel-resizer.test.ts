/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  createTerminalController,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";
import { OpenClawTerminalPanel } from "./terminal-panel.ts";

const createGhosttyTerminalMock: CreateGhosttyTerminalMock = vi.fn();
const terminalPanelElementName = defineTestTerminalPanelElement(createGhosttyTerminalMock);

function pointer(type: string, pointerId: number, clientX: number): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX,
  });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: "touch" },
  });
  return event as PointerEvent;
}

describe("OpenClawTerminalPanel resizer", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    await i18n.setLocale("en");
  });

  afterEach(async () => {
    document.body.replaceChildren();
    document.documentElement.style.removeProperty("--oc-terminal-reserve-bottom");
    document.documentElement.style.removeProperty("--oc-terminal-reserve-right");
    createGhosttyTerminalMock.mockReset();
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  it("keeps terminal touch resizing owned by its initiating pointer", async () => {
    localStorage.setItem(
      "openclaw.terminal.panel.v1",
      JSON.stringify({ open: true, dock: "right", height: 320, width: 520 }),
    );
    createGhosttyTerminalMock.mockResolvedValue(createTerminalController());
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>(method: string) =>
        (method === "terminal.open" ? terminalOpenResult("session-1") : {}) as T,
      addEventListener: () => () => {},
    };
    const panel = document.createElement(terminalPanelElementName) as OpenClawTerminalPanel;
    panel.client = client;
    panel.available = true;
    document.body.append(panel);
    await panel.updateComplete;

    const resizer = panel.renderRoot.querySelector<HTMLElement>(".tp-resizer");
    expect(resizer).not.toBeNull();
    if (!resizer) {
      return;
    }
    const capturedPointers = new Set<number>();
    const setPointerCapture = vi.fn((pointerId) => capturedPointers.add(pointerId));
    resizer.setPointerCapture = setPointerCapture;
    resizer.hasPointerCapture = vi.fn((pointerId) => capturedPointers.has(pointerId));
    resizer.releasePointerCapture = vi.fn((pointerId) => capturedPointers.delete(pointerId));

    const styleResults = Array.isArray(OpenClawTerminalPanel.styles)
      ? OpenClawTerminalPanel.styles
      : [OpenClawTerminalPanel.styles];
    expect(styleResults.map((style) => style.cssText).join("\n")).toMatch(
      /:is\(\.bp-resizer,\s*\.tp-resizer\)\s*\{[^}]*touch-action:\s*none/u,
    );

    resizer.dispatchEvent(pointer("pointerdown", 7, 760));
    expect(setPointerCapture).toHaveBeenCalledWith(7);

    window.dispatchEvent(pointer("pointermove", 8, 650));
    window.dispatchEvent(pointer("pointerup", 8, 650));
    window.dispatchEvent(pointer("pointercancel", 9, 650));
    expect(document.documentElement.style.getPropertyValue("--oc-terminal-reserve-right")).toBe(
      "520px",
    );
    expect(JSON.parse(localStorage.getItem("openclaw.terminal.panel.v1") ?? "{}").width).toBe(520);
    expect(capturedPointers.has(7)).toBe(true);

    window.dispatchEvent(pointer("pointermove", 7, 700));
    expect(document.documentElement.style.getPropertyValue("--oc-terminal-reserve-right")).toBe(
      "580px",
    );
    expect(JSON.parse(localStorage.getItem("openclaw.terminal.panel.v1") ?? "{}").width).toBe(520);
    window.dispatchEvent(pointer("pointerup", 7, 700));
    expect(JSON.parse(localStorage.getItem("openclaw.terminal.panel.v1") ?? "{}").width).toBe(580);
    expect(capturedPointers.has(7)).toBe(false);
  });
});
