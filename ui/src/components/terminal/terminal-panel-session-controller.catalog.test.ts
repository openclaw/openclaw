/* @vitest-environment jsdom */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import { describe, expect, it, vi } from "vitest";
import { CATALOG_SESSION_RELEASED_EVENT } from "../../lib/sessions/catalog-key.ts";
import { prepareCatalogTerminal } from "../../lib/sessions/catalog-terminal-start.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import { TerminalPanelSessionController } from "./terminal-panel-session-controller.ts";
import type {
  TerminalOperation,
  TerminalPanelSessionControllerHost,
  TerminalPanelSessionTab,
} from "./terminal-panel-session-types.ts";
import { createTerminalController, terminalOpenResult } from "./terminal-panel.test-support.ts";

type RestoreBatch = {
  operation: TerminalOperation;
  pending: Map<string, TerminalPanelSessionTab | undefined>;
  userClosedTab: boolean;
};

type PrivateController = {
  captureTerminalOperation(): TerminalOperation | null;
  pendingRestore: RestoreBatch | null;
  restoreExitedSession(sessionId: string, restore: RestoreBatch): Promise<void>;
};

describe("TerminalPanelSessionController catalog release", () => {
  it("announces a prepared catalog session that vanished before restore", async () => {
    const sessionId = "prepared-gone";
    const client: TerminalGatewayClient = {
      forceReconnect: () => {},
      request: async <T>() => terminalOpenResult(sessionId) as T,
      addEventListener: () => () => {},
    };
    await prepareCatalogTerminal(
      client,
      { catalogId: "codex", agentId: "ops", hostId: "gateway:local", cwd: "/work/ops" },
      () => true,
    );
    const viewport = document.body.appendChild(document.createElement("div"));
    const host = {
      isConnected: true,
      client,
      agentId: "ops",
      sessionKey: null,
      available: true,
      themeMode: "dark",
      fullscreen: true,
      page: true,
      routeTarget: { sessionId },
      terminalPanelOpen: true,
      catalogReadyTimeoutMs: 1_000,
      terminalPanelUploadController: { dispose: vi.fn() },
      createTerminalController: async () => createTerminalController(),
      closeTerminalPanel: vi.fn(),
      findTerminalPanelViewport: () => viewport,
      hideTerminalPanelForUnavailableSurface: vi.fn(),
      resetTerminalSessionPicker: vi.fn(),
      restoreTerminalPanelOpenState: () => false,
      addController: (_controller: ReactiveController) => {},
      removeController: (_controller: ReactiveController) => {},
      requestUpdate: vi.fn(),
      updateComplete: Promise.resolve(true),
    } as unknown as TerminalPanelSessionControllerHost & ReactiveControllerHost;
    const controller = new TerminalPanelSessionController(host);
    controller.connectHost();
    const privateController = controller as unknown as PrivateController;
    const operation = privateController.captureTerminalOperation();
    expect(operation).not.toBeNull();
    if (!operation) {
      return;
    }
    const restore: RestoreBatch = {
      operation,
      pending: new Map([[sessionId, undefined]]),
      userClosedTab: false,
    };
    privateController.pendingRestore = restore;
    const released = vi.fn();
    document.addEventListener(CATALOG_SESSION_RELEASED_EVENT, released);

    await privateController.restoreExitedSession(sessionId, restore);

    expect(released).toHaveBeenCalledOnce();
    const event = released.mock.calls.at(0)?.at(0) as CustomEvent | undefined;
    expect(event?.detail).toMatchObject({
      agentId: "ops",
      catalogId: "codex",
      hostId: "gateway:local",
    });
    document.removeEventListener(CATALOG_SESSION_RELEASED_EVENT, released);
    controller.disconnectHost();
    viewport.remove();
  });
});
