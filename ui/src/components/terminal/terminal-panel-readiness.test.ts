/* @vitest-environment jsdom */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import "./terminal-panel-registration.ts";
import type { OpenClawTerminalPanel } from "./terminal-panel.ts";
import type { createIsolatedGhosttyTerminal } from "./terminal-runtime.ts";

function createTerminalController() {
  return {
    readOnly: false,
    terminal: {
      options: { fontFamily: "" },
      cols: 100,
      rows: 30,
      viewportY: 0,
      write: vi.fn(),
      focus: vi.fn(),
      reset: vi.fn(),
      paste: vi.fn(),
    },
    write: vi.fn(),
    fit: vi.fn(),
    resize: vi.fn(),
    setReadOnly: vi.fn(),
    attach: vi.fn(),
    dispose: vi.fn(),
  };
}

const createTerminal = vi.fn(async () => createTerminalController());

function createReadinessPanel(): OpenClawTerminalPanel {
  const panel = document.createElement("openclaw-terminal-panel");
  panel.createTerminalController =
    createTerminal as unknown as typeof createIsolatedGhosttyTerminal;
  return panel;
}

function terminalOpenResult(sessionId: string) {
  return {
    sessionId,
    agentId: "main",
    shell: "/bin/zsh",
    cwd: "/work",
    confined: false,
  };
}

describe("terminal panel readiness", () => {
  beforeAll(async () => {
    // Load the real responder before fake time drives readiness deadlines.
    await import("@openclaw/libterminal/browser");
  });

  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    await i18n.setLocale("en");
  });

  afterEach(async () => {
    document.body.replaceChildren();
    await Promise.resolve();
    createTerminal.mockClear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  it("keeps an already closed panel closed for an explicit close request", () => {
    const panel = createReadinessPanel();
    panel.available = true;
    document.body.append(panel);

    panel.handleToggleRequest(
      new CustomEvent("openclaw:terminal-toggle", { detail: { open: false } }),
    );

    expect(panel.terminalPanelOpen).toBe(false);
  });

  it.each([
    { siblingReady: "after timeout", siblingExit: "none" },
    { siblingReady: "before timeout", siblingExit: "error" },
    { siblingReady: "before timeout", siblingExit: "no error" },
  ] as const)(
    "keeps the matching retry with sibling readiness $siblingReady and exit $siblingExit",
    async ({ siblingReady, siblingExit }) => {
      vi.useFakeTimers();
      createTerminal.mockImplementation(async () => createTerminalController());
      const siblingOpen = createDeferred<ReturnType<typeof terminalOpenResult>>();
      const requests: Array<{ method: string; params: unknown }> = [];
      let listener: Parameters<TerminalGatewayClient["addEventListener"]>[0] | undefined;
      const client: TerminalGatewayClient = {
        forceReconnect: () => {},
        request: async <T>(method: string, params?: unknown) => {
          requests.push({ method, params });
          if (method === "terminal.open" && !(params as { catalog?: unknown }).catalog) {
            return siblingOpen.promise as Promise<T>;
          }
          return (
            method === "terminal.open"
              ? { ...terminalOpenResult("catalog-terminal-1"), title: "claude --resume 1234…" }
              : { ok: true }
          ) as T;
        },
        addEventListener: (nextListener) => {
          listener = nextListener;
          return () => {
            listener = undefined;
          };
        },
      };
      const panel = createReadinessPanel();
      panel.client = client;
      panel.available = true;
      panel.agentId = "research";
      panel.catalogReadyTimeoutMs = 1_000;
      const catalog = { catalogId: "anthropic", hostId: "node:mac", threadId: "thread" };
      panel.page = panel.fullscreen = panel.embedded = true;
      panel.routeTarget = { catalog };
      document.body.append(panel);
      await panel.updateComplete;
      await vi.dynamicImportSettled();

      await vi.waitFor(() => {
        expect(panel.querySelector<HTMLButtonElement>(".tabstrip-new")?.disabled).toBe(false);
        expect(requests.filter((request) => request.method === "terminal.open")).toHaveLength(1);
      });
      panel.agentId = "other";
      panel.querySelector<HTMLButtonElement>(".tabstrip-new")!.click();
      await vi.waitFor(() => {
        expect(requests.filter((request) => request.method === "terminal.open")).toHaveLength(2);
      });
      if (siblingReady === "before timeout") {
        siblingOpen.resolve(terminalOpenResult("sibling-terminal"));
        await vi.waitFor(() => expect(panel.querySelector(".is-live")).not.toBeNull());
      }
      await vi.advanceTimersByTimeAsync(1_000);
      await panel.updateComplete;
      expect(panel.querySelector(".tp-error")?.textContent).toContain(
        "Session did not connect within 30 seconds",
      );
      if (siblingReady === "after timeout") {
        siblingOpen.resolve(terminalOpenResult("sibling-terminal"));
        await vi.waitFor(() => expect(panel.querySelector(".is-live")).not.toBeNull());
      }
      await vi.waitFor(() => {
        expect(panel.querySelector(".tp-error")?.textContent).toContain(
          "Session did not connect within 30 seconds",
        );
      });
      expect(requests).toContainEqual({
        method: "terminal.close",
        params: { sessionId: "catalog-terminal-1" },
      });
      expect(panel.querySelectorAll(".tabstrip-tab")).toHaveLength(1);
      expect(requests.filter((request) => request.method === "terminal.close")).toEqual([
        { method: "terminal.close", params: { sessionId: "catalog-terminal-1" } },
      ]);
      const retry = panel.querySelector<HTMLButtonElement>(".tp-error button");
      expect(retry?.textContent?.trim()).toBe("Retry");

      if (siblingExit !== "none") {
        const exitError = "The sibling terminal stopped unexpectedly.";
        listener?.({
          event: "terminal.exit",
          payload: {
            sessionId: "sibling-terminal",
            reason: "process_exit",
            exitCode: 1,
            ...(siblingExit === "error" ? { error: exitError } : {}),
          },
        });
        if (siblingExit === "error") {
          retry?.click();
        }
        await panel.updateComplete;
        expect(panel.querySelector(".tabstrip-tab__status")?.textContent).toBe("exited (1)");
        if (siblingExit === "error") {
          expect(panel.querySelector(".tp-error")?.textContent).toContain(exitError);
          expect(panel.querySelector(".tp-error button")).toBeNull();
          expect(requests.filter((request) => request.method === "terminal.open")).toHaveLength(2);
          return;
        }
        expect(panel.querySelector(".tp-error")?.textContent).toContain(
          "Session did not connect within 30 seconds",
        );
        expect(panel.querySelector(".tp-error button")?.textContent?.trim()).toBe("Retry");
      }

      retry?.click();
      await vi.waitFor(() => {
        expect(requests.filter((request) => request.method === "terminal.open")).toHaveLength(3);
      });
      expect(requests.findLast((request) => request.method === "terminal.open")?.params).toEqual(
        expect.objectContaining({ catalog, agentId: "research" }),
      );
    },
  );
});
