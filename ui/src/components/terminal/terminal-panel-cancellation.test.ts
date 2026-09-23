/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  createTerminalController,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";
import type { OpenClawTerminalPanel } from "./terminal-panel.ts";
import { TerminalIntentQueue } from "./terminal-pending-actions.ts";

vi.mock("../../app/sw-refresh.runtime.ts", () => ({
  refreshControlUiServiceWorker: vi.fn(async () => false),
}));

const createGhosttyTerminalMock: CreateGhosttyTerminalMock = vi.fn();
const TERMINAL_PANEL_ELEMENT_NAME = defineTestTerminalPanelElement(createGhosttyTerminalMock);
const panels: OpenClawTerminalPanel[] = [];
const releaseResponses: Array<() => void> = [];

function mountTerminalPanel(client: TerminalGatewayClient): OpenClawTerminalPanel {
  const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
  panel.client = client;
  panel.available = true;
  panels.push(panel);
  document.body.append(panel);
  return panel;
}

describe("terminal panel pending cancellation", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    await i18n.setLocale("en");
  });

  afterEach(async () => {
    for (const panel of panels) {
      panel.closeTerminalPanel();
    }
    document.body.replaceChildren();
    for (const release of releaseResponses) {
      release();
    }
    await Promise.all(panels.map((panel) => panel.updateComplete));
    panels.length = 0;
    releaseResponses.length = 0;
    createGhosttyTerminalMock.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(
    (["open", "attach"] as const).flatMap((kind) => [
      { kind, outcome: "resolve", cancelled: true, reconnect: false, page: true },
      { kind, outcome: "reject", cancelled: true, reconnect: false, page: true },
      { kind, outcome: "reject", cancelled: false, reconnect: false, page: true },
      { kind, outcome: "resolve", cancelled: true, reconnect: true, page: false },
    ]),
  )(
    "settles $kind $outcome without reviving a cancelled tab (cancelled: $cancelled, reconnect: $reconnect, page: $page)",
    async ({ kind, outcome, cancelled, reconnect, page }) => {
      const queueCalls = vi.spyOn(TerminalIntentQueue.prototype, "queue");
      createGhosttyTerminalMock.mockImplementation(async () => createTerminalController());
      const response = (sessionId: string) => ({
        ...terminalOpenResult(sessionId),
        buffer: "",
        seq: 0,
      });
      const pending = createDeferred<ReturnType<typeof response>>();
      releaseResponses.push(() => pending.resolve(response("cleanup-session")));
      const requests: Array<{ method: string; params: unknown }> = [];
      const targetMethod = `terminal.${kind}`;
      const client: TerminalGatewayClient = {
        forceReconnect: () => {},
        request: <T>(method: string, params?: unknown) => {
          requests.push({ method, params });
          if (method === targetMethod) {
            return (
              requests.filter((request) => request.method === targetMethod).length === 1
                ? pending.promise
                : Promise.resolve(response("unexpected-replay"))
            ) as Promise<T>;
          }
          return Promise.resolve({}) as Promise<T>;
        },
        addEventListener: () => () => {},
      };
      const panel = document.createElement(TERMINAL_PANEL_ELEMENT_NAME) as OpenClawTerminalPanel;
      panel.client = client;
      panel.available = true;
      panel.page = panel.fullscreen = panel.embedded = page;
      panel.routeTarget = kind === "attach" ? { sessionId: "pending-session" } : null;
      panels.push(panel);
      document.body.append(panel);
      if (!page) {
        window.dispatchEvent(
          new CustomEvent("openclaw:terminal-toggle", {
            detail: {
              open: true,
              ...(kind === "attach" ? { terminalSessionId: "pending-session" } : {}),
            },
          }),
        );
      }
      await waitForFast(() =>
        expect(requests.filter((request) => request.method === targetMethod)).toHaveLength(1),
      );
      if (cancelled) {
        panel.renderRoot.querySelector<HTMLButtonElement>(".tabstrip-tab__close")!.click();
        await panel.updateComplete;
        expect(panel.renderRoot.querySelector(".tabstrip-tab")).toBeNull();
        expect(panel.renderRoot.querySelector(".tp-error")).toBeNull();
      }
      if (reconnect) {
        expect(panel.terminalPanelOpen).toBe(false);
        panel.client = null;
        panel.available = false;
        await panel.updateComplete;
        panel.client = client;
        panel.available = true;
        await panel.updateComplete;
      }
      if (outcome === "resolve") {
        pending.resolve(response("pending-session"));
      } else {
        pending.reject(new Error("terminal request failed"));
      }
      await Promise.all(queueCalls.mock.results.map((result) => result.value));
      await waitForFast(() =>
        expect(
          panel.terminalPanelOpen
            ? panel.renderRoot.querySelector<HTMLButtonElement>(".tabstrip-new")?.disabled
            : false,
        ).toBe(false),
      );
      expect(requests.filter((request) => request.method === targetMethod)).toHaveLength(1);
      expect(panel.renderRoot.querySelector(".tabstrip-tab")).toBeNull();
      expect(panel.terminalPanelOpen).toBe(page);
      if (cancelled) {
        expect(panel.renderRoot.querySelector(".tp-error")).toBeNull();
      } else {
        expect(panel.renderRoot.querySelector(".tp-error")?.textContent).toContain(
          "terminal request failed",
        );
      }
      expect(requests.filter((request) => request.method === "terminal.close")).toEqual(
        outcome === "resolve"
          ? [{ method: "terminal.close", params: { sessionId: "pending-session" } }]
          : [],
      );
    },
  );

  it.each([
    { transition: "queued attach", healthy: true },
    { transition: "queued attach", healthy: false },
    { transition: "reconnect", healthy: true },
  ] as const)(
    "preserves other work after a pending tab closes before $transition (healthy sibling: $healthy)",
    async ({ transition, healthy }) => {
      createGhosttyTerminalMock.mockImplementation(async () => createTerminalController());
      const healthyController = createTerminalController();
      createGhosttyTerminalMock.mockResolvedValueOnce(healthyController);
      const pending = createDeferred<ReturnType<typeof terminalOpenResult>>();
      releaseResponses.push(() => pending.resolve(terminalOpenResult("cleanup-session")));
      const requests: Array<{ method: string; params: unknown }> = [];
      const pendingOpenIndex = healthy ? 2 : 1;
      let openCount = 0;
      const client: TerminalGatewayClient = {
        forceReconnect: () => {},
        request: <T>(method: string, params?: unknown) => {
          requests.push({ method, params });
          if (method === "terminal.open") {
            openCount += 1;
            return (
              openCount === pendingOpenIndex
                ? pending.promise
                : Promise.resolve(terminalOpenResult(openCount === 1 ? "healthy" : "replayed"))
            ) as Promise<T>;
          }
          if (method === "terminal.list") {
            return Promise.resolve({
              sessions: [{ ...terminalOpenResult("healthy"), attached: false, createdAtMs: 1 }],
            }) as Promise<T>;
          }
          if (method === "terminal.attach") {
            const { sessionId } = params as { sessionId: string };
            return Promise.resolve({
              ...terminalOpenResult(sessionId),
              buffer: "ready",
              seq: 5,
            }) as Promise<T>;
          }
          return Promise.resolve({}) as Promise<T>;
        },
        addEventListener: () => () => {},
      };
      const panel = mountTerminalPanel(client);
      panel.toggle();
      if (healthy) {
        await waitForFast(() =>
          expect(panel.renderRoot.querySelector<HTMLButtonElement>(".tabstrip-new")?.disabled).toBe(
            false,
          ),
        );
        panel.renderRoot.querySelector<HTMLButtonElement>(".tabstrip-new")!.click();
      }
      await waitForFast(() => expect(openCount).toBe(pendingOpenIndex));
      if (transition === "queued attach") {
        window.dispatchEvent(
          new CustomEvent("openclaw:terminal-toggle", {
            detail: { open: true, terminalSessionId: "queued-session" },
          }),
        );
        expect(requests.filter((request) => request.method === "terminal.attach")).toHaveLength(0);
      }
      panel.renderRoot
        .querySelector<HTMLButtonElement>(".is-connecting + .tabstrip-tab__close")!
        .click();
      await panel.updateComplete;
      expect(panel.terminalPanelOpen).toBe(true);
      if (transition === "reconnect") {
        panel.client = null;
        panel.available = false;
        await panel.updateComplete;
        await waitForFast(() => expect(healthyController.dispose).toHaveBeenCalledOnce());
        panel.client = client;
        panel.available = true;
        await panel.updateComplete;
      }
      pending.resolve(terminalOpenResult("cancelled-session"));
      await waitForFast(() => {
        expect(panel.renderRoot.querySelector<HTMLButtonElement>(".tabstrip-new")?.disabled).toBe(
          false,
        );
        expect(
          openCount > pendingOpenIndex ||
            requests.filter((request) => request.method === "terminal.attach").length === 1,
        ).toBe(true);
      });
      expect(openCount).toBe(pendingOpenIndex);
      expect(requests.filter((request) => request.method === "terminal.attach")).toEqual([
        {
          method: "terminal.attach",
          params: { sessionId: transition === "reconnect" ? "healthy" : "queued-session" },
        },
      ]);
      expect(panel.renderRoot.querySelector(".tp-error")).toBeNull();
      expect(JSON.parse(sessionStorage.getItem("openclaw.terminal.sessions.v1") ?? "[]")).toEqual(
        transition === "reconnect"
          ? ["healthy"]
          : healthy
            ? ["healthy", "queued-session"]
            : ["queued-session"],
      );
      expect(requests.filter((request) => request.method === "terminal.close")).toEqual([
        { method: "terminal.close", params: { sessionId: "cancelled-session" } },
      ]);
    },
  );
});
