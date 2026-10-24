import { afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { CatalogSessionKey } from "../../lib/sessions/catalog-key.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { TerminalPanelToggleDetail } from "../panel-toggle-contract.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  createTestTerminalPanel,
  createTerminalController,
  defineTestTerminalPanelElement,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";
import type { OpenClawTerminalPanel } from "./terminal-panel.ts";

export function panelFixture(timers = false, afterUnmount = () => {}, autoCreate = true) {
  const create: CreateGhosttyTerminalMock = vi.fn();
  const tag = defineTestTerminalPanelElement(create);
  const terminals: ReturnType<typeof createTerminalController>[] = [];
  panelTestStorage(create, timers, afterUnmount);
  beforeEach(() => {
    terminals.length = 0;
    if (autoCreate) {
      create.mockImplementation(async () => {
        const terminal = createTerminalController();
        terminals.push(terminal);
        return terminal;
      });
    }
  });
  return {
    create,
    terminals,
    mount: (props: Partial<OpenClawTerminalPanel>, open = true) =>
      mountPanel(tag, { available: true, ...props }, open),
  };
}

export function queueCatalog(catalog: CatalogSessionKey, agentId = "ops") {
  sessionStorage.setItem(
    "openclaw.terminal.actions.v1",
    JSON.stringify([{ kind: "catalog", agentId, catalog }]),
  );
}

export function panelTestStorage(
  create: CreateGhosttyTerminalMock,
  timers = false,
  afterUnmount: () => void | Promise<void> = () => {},
  beforeUnmount = () => {},
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
    beforeUnmount();
    document.body.replaceChildren();
    await Promise.resolve();
    const cleanup = afterUnmount();
    if (cleanup) {
      await cleanup;
    }
    create.mockReset();
    vi.unstubAllGlobals();
    if (timers) {
      vi.useRealTimers();
    }
  });
}

export const panelButton = (panel: HTMLElement, selector = ".tabstrip-new") =>
  panel.querySelector<HTMLButtonElement>(selector);

export const waitForPanelReady = (panel: HTMLElement) =>
  waitForFast(() => expect(panelButton(panel)?.disabled).toBe(false));

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
    calls: (method: string) =>
      request.mock.calls.filter(([name]) => name === method).map(([, params]) => params),
    emit: (event: string, payload: unknown) => {
      for (const listener of listeners) {
        listener({ event, payload });
      }
    },
  };
}
