/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  eventGateway,
  mountPanel,
  panelButton,
  panelTestStorage,
  waitForPanelReady,
} from "./terminal-panel-lifecycle.test-support.ts";
import {
  createTerminalController,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";
import type { OpenClawTerminalPanel } from "./terminal-panel.ts";

vi.mock("../../app/sw-refresh.runtime.ts", () => ({
  refreshControlUiServiceWorker: vi.fn(async () => false),
}));

const createGhosttyTerminalMock: CreateGhosttyTerminalMock = vi.fn();
const TERMINAL_PANEL_ELEMENT_NAME = defineTestTerminalPanelElement(createGhosttyTerminalMock);
const panels: OpenClawTerminalPanel[] = [];
const releaseResponses: Array<() => void> = [];

function mountTerminalPanel(
  client: TerminalGatewayClient,
  props: Partial<OpenClawTerminalPanel> = {},
): OpenClawTerminalPanel {
  const panel = mountPanel(
    TERMINAL_PANEL_ELEMENT_NAME,
    { client, available: true, ...props },
    false,
  );
  panels.push(panel);
  return panel;
}

describe("terminal panel pending cancellation", () => {
  panelTestStorage(
    createGhosttyTerminalMock,
    false,
    async () => {
      for (const release of releaseResponses) {
        release();
      }
      await Promise.all(panels.map((panel) => panel.updateComplete));
      panels.length = 0;
      releaseResponses.length = 0;
      vi.restoreAllMocks();
    },
    () => panels.forEach((panel) => panel.closeTerminalPanel()),
  );

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
      createGhosttyTerminalMock.mockImplementation(async () => createTerminalController());
      const response = (sessionId: string) => ({
        ...terminalOpenResult(sessionId),
        buffer: "",
        seq: 0,
      });
      const pending = createDeferred<ReturnType<typeof response>>();
      releaseResponses.push(() => pending.resolve(response("cleanup-session")));
      const targetMethod = `terminal.${kind}`;
      let attempts = 0;
      const { client, calls } = eventGateway((method) =>
        method === targetMethod
          ? ++attempts === 1
            ? pending.promise
            : response("unexpected-replay")
          : { ok: true },
      );
      const panel = mountTerminalPanel(client, {
        page,
        fullscreen: page,
        embedded: page,
        routeTarget: kind === "attach" ? { sessionId: "pending-session" } : null,
      });
      await panel.updateComplete;
      await vi.dynamicImportSettled();
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
      await waitForFast(() => expect(calls(targetMethod)).toHaveLength(1));
      if (cancelled) {
        panelButton(panel, ".tabstrip-tab__close")!.click();
        await panel.updateComplete;
        expect(panel.querySelector(".tabstrip-tab")).toBeNull();
        expect(panel.querySelector(".tp-error")).toBeNull();
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
      if (page) {
        expect(panelButton(panel)?.disabled).toBe(true);
      }
      if (outcome === "resolve") {
        pending.resolve(response("pending-session"));
      } else {
        pending.reject(new Error("terminal request failed"));
      }
      if (page) {
        await waitForPanelReady(panel);
      } else {
        await waitForFast(() =>
          expect(calls("terminal.close")).toContainEqual({ sessionId: "pending-session" }),
        );
      }
      expect(calls(targetMethod)).toHaveLength(1);
      expect(panel.querySelector(".tabstrip-tab")).toBeNull();
      expect(panel.terminalPanelOpen).toBe(page);
      if (cancelled) {
        expect(panel.querySelector(".tp-error")).toBeNull();
      } else {
        expect(panel.querySelector(".tp-error")?.textContent).toContain("terminal request failed");
      }
      expect(calls("terminal.close")).toEqual(
        outcome === "resolve" ? [{ sessionId: "pending-session" }] : [],
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
      const pendingOpenIndex = healthy ? 2 : 1;
      let openCount = 0;
      const { client, calls } = eventGateway((method, params) => {
        if (method === "terminal.open") {
          openCount += 1;
          return openCount === pendingOpenIndex
            ? pending.promise
            : terminalOpenResult(openCount === 1 ? "healthy" : "replayed");
        }
        if (method === "terminal.list") {
          return {
            sessions: [{ ...terminalOpenResult("healthy"), attached: false, createdAtMs: 1 }],
          };
        }
        if (method === "terminal.attach") {
          const { sessionId } = params as { sessionId: string };
          return {
            ...terminalOpenResult(sessionId),
            buffer: "ready",
            seq: 5,
          };
        }
        return { ok: true };
      });
      const panel = mountTerminalPanel(client);
      panel.toggle();
      if (healthy) {
        await waitForPanelReady(panel);
        panelButton(panel)!.click();
      }
      await waitForFast(() => expect(openCount).toBe(pendingOpenIndex));
      if (transition === "queued attach") {
        window.dispatchEvent(
          new CustomEvent("openclaw:terminal-toggle", {
            detail: { open: true, terminalSessionId: "queued-session" },
          }),
        );
        expect(calls("terminal.attach")).toHaveLength(0);
      }
      panelButton(panel, ".is-connecting + .tabstrip-tab__close")!.click();
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
        expect(panelButton(panel)?.disabled).toBe(false);
        expect(openCount > pendingOpenIndex || calls("terminal.attach").length === 1).toBe(true);
      });
      expect(openCount).toBe(pendingOpenIndex);
      expect(calls("terminal.attach")).toEqual([
        { sessionId: transition === "reconnect" ? "healthy" : "queued-session" },
      ]);
      expect(panel.querySelector(".tp-error")).toBeNull();
      expect(JSON.parse(sessionStorage.getItem("openclaw.terminal.sessions.v1") ?? "[]")).toEqual(
        transition === "reconnect"
          ? ["healthy"]
          : healthy
            ? ["healthy", "queued-session"]
            : ["queued-session"],
      );
      expect(calls("terminal.close")).toEqual([{ sessionId: "cancelled-session" }]);
    },
  );
});
