/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { TerminalGatewayClient, TerminalSessionInfo } from "./terminal-connection.ts";
import {
  eventGateway,
  panelFixture,
  panelButton,
  togglePanel,
  queueCatalog,
} from "./terminal-panel-lifecycle.test-support.ts";
import { terminalOpenResult } from "./terminal-panel.test-support.ts";

const { create: createTerminal, terminals, mount: mountFixture } = panelFixture(true);

function gatewayFixture(liveCatalog = false) {
  const opened: TerminalSessionInfo[] = [];
  let nextId = 0;
  return eventGateway((method, params) => {
    if (method === "terminal.open") {
      const result = terminalOpenResult(`session-${++nextId}`);
      opened.push({ ...result, attached: true, createdAtMs: 1 });
      return result;
    }
    if (method === "terminal.upload") {
      return { path: "/tmp/synthetic-file.txt", size: 4 };
    }
    if (method === "terminal.attach") {
      const { sessionId } = params as { sessionId: string };
      return { ...terminalOpenResult(sessionId), buffer: "live owner", seq: 10 };
    }
    return method === "terminal.list" ? { sessions: liveCatalog ? opened : [] } : { ok: true };
  });
}

async function mount(client: TerminalGatewayClient, embedded = true, expectedTabs = 1) {
  const panel = mountFixture({ embedded, client });
  await panel.updateComplete;
  await vi.waitFor(() => expect(panel.hostedTabs).toHaveLength(expectedTabs));
  await vi.waitFor(() => expect(panelButton(panel)?.disabled).toBe(false));
  return panel;
}

function dockButton(panel: HTMLElement) {
  const button = panelButton(panel, '[aria-label="Dock to bottom"]');
  expect(button).not.toBeNull();
  return button!;
}

const composerInput = (panel: HTMLElement) =>
  panel.querySelector<HTMLInputElement>('[aria-label="Terminal input"]')!;
const waitForLiveTabs = (panel: Awaited<ReturnType<typeof mount>>) =>
  vi.waitFor(() => expect(panel.hostedTabs.every((tab) => tab.className === "is-live")).toBe(true));

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
  await waitForLiveTabs(target);
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

it("retains unsent text and uploaded attachments across tabs and a native docking handoff", async () => {
  const gateway = gatewayFixture(true);
  const source = await mount(gateway.client);
  const first = source.activeHostedTabId!;
  source.selectHostedTab(first);
  await source.updateComplete;
  const input = composerInput(source);
  input.value = "cat";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const file = new File(["test"], "synthetic-file.txt");
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new TextEncoder().encode("test").buffer,
  });
  const fileInput = source.querySelector<HTMLInputElement>(".tp-file-input")!;
  Object.defineProperty(fileInput, "files", { value: [file] });
  fileInput.dispatchEvent(new Event("change"));
  await vi.waitFor(() =>
    expect(source.querySelector(".tp-attachment")?.textContent).toContain("synthetic-file.txt"),
  );
  expect(terminals[0]!.terminal.paste).not.toHaveBeenCalled();
  expect(terminals[0]!.terminal.input).not.toHaveBeenCalled();
  togglePanel(source, { open: true, newSession: true });
  await vi.waitFor(() => expect(source.hostedTabs).toHaveLength(2));
  await waitForLiveTabs(source);
  await source.updateComplete;
  expect(composerInput(source).value).toBe("");
  source.selectHostedTab(first);
  await source.updateComplete;
  expect(composerInput(source).value).toBe("cat");
  const target = await mount(gateway.client, false, 2);
  source.activateTerminalHost();
  await source.updateComplete;
  dockButton(source).click();
  await vi.waitFor(() => expect(target.hostedTabs).toHaveLength(2));
  await waitForLiveTabs(target);
  target.embedded = true;
  await target.updateComplete;
  await vi.waitFor(() => expect(composerInput(target)?.value).toBe("cat"));
  expect(target.querySelector(".tp-attachment")?.textContent).toContain("synthetic-file.txt");
  expect(
    terminals.every((terminal) => terminal.terminal.paste.mock.calls.length === 0),
    "no paste before submit",
  ).toBe(true);
  target
    .querySelector("form.tp-composer")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await target.updateComplete;
  const submitted = terminals.find((terminal) => terminal.terminal.paste.mock.calls.length > 0)!;
  expect(submitted.terminal.paste).toHaveBeenCalledExactlyOnceWith("cat /tmp/synthetic-file.txt");
  expect(submitted.terminal.input).toHaveBeenCalledExactlyOnceWith("\r", true);
  expect(composerInput(target).value).toBe("");
  expect(target.querySelector(".tp-attachment")).toBeNull();
});

describe("terminal panel readiness", () => {
  it("keeps an already closed panel closed for an explicit close request", () => {
    const panel = mountFixture({}, false);
    togglePanel(panel, { open: false });
    expect(panel.terminalPanelOpen).toBe(false);
  });

  it.each([
    { siblingReady: "after timeout", siblingExit: "none" },
    { siblingReady: "before timeout", siblingExit: "error" },
    { siblingReady: "before timeout", siblingExit: "no error" },
  ] as const)(
    "keeps the matching retry with sibling readiness $siblingReady and exit $siblingExit",
    async ({ siblingReady, siblingExit }) => {
      const siblingOpen = createDeferred<ReturnType<typeof terminalOpenResult>>();
      const { client, calls, emit } = eventGateway((method, params) => {
        if (method === "terminal.open" && !(params as { catalog?: unknown }).catalog) {
          return siblingOpen.promise;
        }
        return method === "terminal.open"
          ? { ...terminalOpenResult("catalog-terminal-1"), title: "claude --resume 1234…" }
          : { ok: true };
      });
      const catalog = { catalogId: "anthropic", hostId: "node:mac", threadId: "thread" };
      const panel = mountFixture(
        {
          client,
          agentId: "research",
          page: true,
          fullscreen: true,
          embedded: true,
          routeTarget: { catalog },
        },
        false,
      );
      await panel.updateComplete;
      await vi.dynamicImportSettled();

      await vi.waitFor(() => {
        expect(panelButton(panel)?.disabled).toBe(false);
        expect(calls("terminal.open")).toHaveLength(1);
      });
      panel.agentId = "other";
      panelButton(panel)!.click();
      await vi.waitFor(() => expect(calls("terminal.open")).toHaveLength(2));
      const resolveSibling = async () => {
        siblingOpen.resolve(terminalOpenResult("sibling-terminal"));
        await vi.waitFor(() => expect(panel.querySelector(".is-live")).not.toBeNull());
      };
      const expectTimeout = () =>
        expect(panel.querySelector(".tp-error")?.textContent).toContain(
          "Session did not connect within 30 seconds",
        );
      if (siblingReady === "before timeout") {
        await resolveSibling();
      }
      await vi.advanceTimersByTimeAsync(30_000);
      await panel.updateComplete;
      expectTimeout();
      if (siblingReady === "after timeout") {
        await resolveSibling();
      }
      await vi.waitFor(expectTimeout);
      expect(panel.querySelectorAll(".tabstrip-tab")).toHaveLength(1);
      expect(calls("terminal.close")).toEqual([{ sessionId: "catalog-terminal-1" }]);
      const retry = panelButton(panel, ".tp-error button");
      expect(retry?.textContent?.trim()).toBe("Retry");

      if (siblingExit !== "none") {
        const exitError = "The sibling terminal stopped unexpectedly.";
        emit("terminal.exit", {
          sessionId: "sibling-terminal",
          reason: "process_exit",
          exitCode: 1,
          ...(siblingExit === "error" ? { error: exitError } : {}),
        });
        if (siblingExit === "error") {
          retry?.click();
        }
        await panel.updateComplete;
        expect(panel.querySelector(".tabstrip-tab__status")?.textContent).toBe("exited (1)");
        if (siblingExit === "error") {
          expect(panel.querySelector(".tp-error")?.textContent).toContain(exitError);
          expect(panel.querySelector(".tp-error button")).toBeNull();
          expect(calls("terminal.open")).toHaveLength(2);
          return;
        }
        expectTimeout();
        expect(panel.querySelector(".tp-error button")?.textContent?.trim()).toBe("Retry");
      }

      retry?.click();
      await vi.waitFor(() => expect(calls("terminal.open")).toHaveLength(3));
      expect(calls("terminal.open").at(-1)).toEqual(
        expect.objectContaining({ catalog, agentId: "research" }),
      );
    },
  );
});
