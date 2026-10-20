import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { TerminalPanelToggleDetail } from "../panel-toggle-contract.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  createTestTerminalPanel,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";
import type { OpenClawTerminalPanel } from "./terminal-panel.ts";

export function panelTestStorage(
  create: CreateGhosttyTerminalMock,
  timers = false,
  afterUnmount = () => {},
) {
  beforeAll(async () => {
    await import("@openclaw/libterminal/browser");
  });
  beforeEach(async () => {
    if (timers) {
      vi.useFakeTimers();
    }
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    await i18n.setLocale("en");
  });
  afterEach(async () => {
    document.body.replaceChildren();
    await Promise.resolve();
    afterUnmount();
    create.mockReset();
    vi.unstubAllGlobals();
    if (timers) {
      vi.useRealTimers();
    }
  });
}

export const panelButton = (panel: HTMLElement, selector = ".tabstrip-new") =>
  panel.querySelector<HTMLButtonElement>(selector);

export function togglePanel(panel: OpenClawTerminalPanel, detail: TerminalPanelToggleDetail) {
  panel.handleToggleRequest(new CustomEvent("openclaw:terminal-toggle", { detail }));
}

export function mountPanel(tag: string, props: Partial<OpenClawTerminalPanel>, open = true) {
  const panel = Object.assign(createTestTerminalPanel(tag), props);
  document.body.append(panel);
  if (open && !panel.terminalPanelOpen) {
    panel.toggle();
  }
  return panel;
}

export function eventGateway(respond: (method: string, params?: unknown) => unknown) {
  const listeners = new Set<Parameters<TerminalGatewayClient["addEventListener"]>[0]>();
  const request = vi.fn(async (method: string, params?: unknown) => respond(method, params));
  const client: TerminalGatewayClient = {
    forceReconnect: vi.fn(),
    request: request as TerminalGatewayClient["request"],
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
