/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  SessionCatalog,
  SessionCatalogSession,
  TerminalOpenParams,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { AgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationNavigationOptions } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { openCatalogSessionInTerminal } from "../../lib/sessions/catalog-terminal.ts";
import { resolveTerminalRouteLocation } from "../../pages/terminal/route-location.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { renderSessionCatalogGroups } from "../app-sidebar-session-catalog-render.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import type { TerminalPanelSessionController } from "./terminal-panel-session-controller.ts";
import {
  createTerminalController,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";
import type { OpenClawTerminalPanel } from "./terminal-panel.ts";
import {
  loadPersistedTerminalActions,
  persistTerminalActions,
} from "./terminal-session-storage.ts";
import type { TerminalTaskQueue } from "./terminal-task-queue.ts";

const createTerminal: CreateGhosttyTerminalMock = vi.fn();
const PANEL_TAG = defineTestTerminalPanelElement(createTerminal);
const locator = { catalogId: "fixture-native", hostId: "gateway:local", threadId: "same-thread" };
const mounted: Array<{
  panel: OpenClawTerminalPanel;
  sessions: TerminalPanelSessionController;
  gateway: ReturnType<typeof configuredGateway>;
}> = [];

function clickTerminalRow(sourceHomeId: string | undefined) {
  const selected: SessionCatalogSession = {
    threadId: locator.threadId,
    name: "Selected native session",
    status: "idle",
    archived: false,
    canContinue: true,
    canArchive: true,
    canOpenTerminal: true,
    ...(sourceHomeId !== undefined ? { sourceHomeId } : {}),
  };
  const host = {
    hostId: locator.hostId,
    label: "Gateway",
    kind: "gateway" as const,
    connected: true,
    sessions: [selected],
  };
  const catalog: SessionCatalog = {
    id: locator.catalogId,
    label: "Native sessions",
    capabilities: { continueSession: true, archive: true },
    hosts: [host],
  };
  const agentState = { selectedId: null as string | null, scopeId: null as string | null };
  const agentSelection: AgentSelectionCapability = {
    state: agentState,
    intentRevision: 0,
    set: (agentId) => {
      agentState.selectedId = agentId;
    },
    setScope: (agentId) => {
      agentState.scopeId = agentId;
    },
    subscribe: () => () => {},
  };
  const onNavigate = vi.fn((_routeId: "terminal", _options?: ApplicationNavigationOptions) => {});
  const navigationHost = { basePath: "", sessionDataContext: { agentSelection }, onNavigate };
  const mount = document.body.appendChild(document.createElement("div"));
  render(
    renderSessionCatalogGroups({
      catalogs: [{ ...catalog, visibleHosts: [host] }],
      connected: true,
      basePath: "",
      routeSessionKey: "agent:research:main",
      newSessionAgentId: "research",
      mainKey: "main",
      collapsedSections: new Set(),
      loadingMoreCatalogIds: new Set(),
      visibleSessionLimits: new Map(),
      projectGrouping: "none",
      liveRows: [],
      renderLiveRow: () => nothing,
      onToggleSection: vi.fn(),
      draggingSectionId: null,
      sectionDropTarget: null,
      onSectionDragOver: vi.fn(),
      onSectionDragLeave: vi.fn(),
      onSectionDrop: vi.fn(),
      onStartSectionDrag: vi.fn(),
      onFinishSectionDrag: vi.fn(),
      viewMenuOpenCatalogId: null,
      ownerFilterActive: false,
      onOpenViewMenu: vi.fn(),
      onLoadMore: vi.fn(),
      onSetVisibleSessionLimit: vi.fn(),
      catalogOpenTarget: "terminal",
      terminalAvailable: true,
      onOpenTerminal: (key, agentId) => openCatalogSessionInTerminal(navigationHost, key, agentId),
      onOpenMenu: vi.fn(),
      onCatalogMenuTriggerRendered: vi.fn(),
      isMenuOpen: () => false,
    }),
    mount,
  );
  expectDefined(
    mount.querySelector<HTMLAnchorElement>(".sidebar-recent-session__link"),
    "catalog row",
  ).click();
  expect(onNavigate).toHaveBeenCalledOnce();
  const options = expectDefined(onNavigate.mock.calls[0]?.[1], "terminal navigation");
  const target = resolveTerminalRouteLocation(
    {
      pathname: expectDefined(options.pathname, "terminal pathname"),
      search: options.search ?? "",
      hash: options.hash ?? "",
    },
    "",
  );
  if (!target || !("catalog" in target)) {
    throw new Error("Rendered catalog row did not select a terminal route");
  }
  return { selected, target, agentId: agentState.selectedId };
}

function configuredGateway() {
  const configuredSourceHomeId = "home-b";
  const openedSources: string[] = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  const listeners = new Set<Parameters<TerminalGatewayClient["addEventListener"]>[0]>();
  const client: TerminalGatewayClient = {
    forceReconnect: vi.fn(),
    request: async <T>(method: string, params?: unknown): Promise<T> => {
      requests.push({ method, params });
      if (method === "terminal.open") {
        const input = params as TerminalOpenParams;
        const sourceHomeId = input.catalog?.sourceHomeId;
        if (sourceHomeId !== undefined && sourceHomeId !== configuredSourceHomeId) {
          throw new GatewayRequestError({
            code: "FORBIDDEN",
            message: "The selected source home changed.",
          });
        }
        openedSources.push(configuredSourceHomeId);
        return { ...terminalOpenResult("configured-b-shell"), title: "Configured home B" } as T;
      }
      if (method === "terminal.list") {
        return { sessions: [] } as T;
      }
      if (method === "terminal.close" || method === "terminal.resize") {
        return {} as T;
      }
      throw new Error(`Unexpected gateway request: ${method}`);
    },
    addEventListener: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    client,
    requests,
    openedSources,
    listeners,
    emitReady: () => {
      for (const listener of listeners) {
        listener({
          event: "terminal.data",
          payload: { sessionId: "configured-b-shell", seq: 5, data: "ready" },
        });
      }
    },
  };
}

function mountTerminal(selection: ReturnType<typeof clickTerminalRow>, persisted: boolean) {
  const gateway = configuredGateway();
  if (persisted) {
    // The storage input is the actual parsed row navigation, not a repaired fixture locator.
    persistTerminalActions([
      { kind: "catalog", agentId: selection.agentId, catalog: selection.target.catalog },
    ]);
  }
  const panel = document.createElement(PANEL_TAG) as OpenClawTerminalPanel;
  panel.client = gateway.client;
  panel.available = true;
  panel.agentId = selection.agentId;
  panel.page = panel.fullscreen = panel.embedded = !persisted;
  if (!persisted) {
    panel.routeTarget = selection.target;
  }
  const sessions = (panel as unknown as { terminalSessions: TerminalPanelSessionController })
    .terminalSessions;
  mounted.push({ panel, sessions, gateway });
  document.body.append(panel);
  if (!panel.terminalPanelOpen) {
    panel.toggle();
  }
  return { panel, sessions, gateway };
}

describe("catalog terminal source navigation", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    createTerminal.mockImplementation(async () => createTerminalController());
    await i18n.setLocale("en");
  });

  afterEach(async () => {
    for (const { sessions, panel } of mounted) {
      sessions.cancelPendingActions();
      panel.remove();
    }
    // Join the existing owner queues even when an unpatched-source assertion fails.
    await Promise.all(
      mounted.map(({ sessions }) =>
        (sessions as unknown as { bootQueue: TerminalTaskQueue }).bootQueue.enqueue(async () => {}),
      ),
    );
    for (const { gateway } of mounted) {
      expect(gateway.listeners.size).toBe(0);
    }
    mounted.length = 0;
    document.body.replaceChildren();
    createTerminal.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  describe.each([false, true])("persisted action: %s", (persisted) => {
    it.each([
      { name: "stale selected A", sourceHomeId: "home-a", allowed: false },
      { name: "current selected B", sourceHomeId: "home-b", allowed: true },
      { name: "legacy unbound", sourceHomeId: undefined, allowed: true },
    ])("preserves the $name selection through terminal.open", async ({ sourceHomeId, allowed }) => {
      const selection = clickTerminalRow(sourceHomeId);
      const { panel, sessions, gateway } = mountTerminal(selection, persisted);
      await waitForFast(() =>
        expect(gateway.requests.filter(({ method }) => method === "terminal.open")).toHaveLength(1),
      );
      await waitForFast(() =>
        expect(
          Boolean(sessions.error) ||
            sessions.tabs.some((tab) => tab.gatewaySessionId === "configured-b-shell"),
        ).toBe(true),
      );
      // Let both repaired and unpatched success paths finish before asserting the outcome.
      if (gateway.openedSources.length > 0) {
        gateway.emitReady();
        await waitForFast(() => expect(sessions.tabs[0]?.status).toBe("live"));
      }
      await panel.updateComplete;

      expect(gateway.openedSources).toEqual(allowed ? ["home-b"] : []);
      if (allowed) {
        expect(sessions.error).toBeNull();
        expect(panel.renderRoot.querySelector(".tp-error")).toBeNull();
        expect(sessions.tabs[0]?.gatewaySessionId).toBe("configured-b-shell");
      } else {
        expect(sessions.tabs).toEqual([]);
        expect(panel.renderRoot.querySelector(".tp-error")?.textContent).toContain(
          "The selected source home changed.",
        );
      }
      const expectedCatalog = !allowed
        ? { ...locator, sourceHomeId }
        : sourceHomeId === undefined
          ? locator
          : expect.objectContaining(locator);
      expect(gateway.requests.filter(({ method }) => method === "terminal.open")).toEqual([
        {
          method: "terminal.open",
          params: { agentId: "research", cols: 100, rows: 30, catalog: expectedCatalog },
        },
      ]);
      expect(gateway.requests.some(({ method }) => method.startsWith("sessions.catalog."))).toBe(
        false,
      );
    });
  });

  it.each([null, "", 123])(
    "rejects invalid stored home %j instead of stripping the constraint",
    (sourceHomeId) => {
      sessionStorage.setItem(
        "openclaw.terminal.actions.v1",
        JSON.stringify([
          { kind: "catalog", agentId: "research", catalog: { ...locator, sourceHomeId } },
        ]),
      );
      expect(loadPersistedTerminalActions()).toEqual([]);
    },
  );
});
