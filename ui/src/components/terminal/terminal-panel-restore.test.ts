/* @vitest-environment jsdom */
import type { TerminalAttachResult } from "@openclaw/gateway-protocol";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.ts";
import { refreshControlUiServiceWorker } from "../../app/sw-refresh.runtime.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  eventGateway,
  mountPanel as mount,
  panelButton,
  panelTestStorage,
  queueCatalog,
  togglePanel,
  waitForPanelReady,
} from "./terminal-panel-lifecycle.test-support.ts";
import {
  createTerminalController,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";
import type { OpenClawTerminalPanel } from "./terminal-panel.ts";
vi.mock("../../app/sw-refresh.runtime.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/sw-refresh.runtime.ts")>()),
  refreshControlUiServiceWorker: vi.fn(async () => false),
}));
const STORAGE_KEY = "openclaw.terminal.sessions.v1";
const createTerminal: CreateGhosttyTerminalMock = vi.fn();
const PANEL_TAG = defineTestTerminalPanelElement(createTerminal);
const mounted: OpenClawTerminalPanel[] = [];
const terminals: ReturnType<typeof createTerminalController>[] = [];
const releaseResponses: Array<() => void> = [];
let verifyDisposal = false;
panelTestStorage(
  createTerminal,
  false,
  async () => {
    for (const release of releaseResponses) {
      release();
    }
    await Promise.all(mounted.map((panel) => panel.updateComplete));
    if (verifyDisposal) {
      // Include controllers produced by delayed replies in the restore teardown proof.
      for (const result of createTerminal.mock.results) {
        if (result.type === "return") {
          const terminal = await result.value;
          await waitForFast(() => expect(terminal.dispose).toHaveBeenCalled());
        }
      }
    }
    mounted.length = terminals.length = releaseResponses.length = 0;
    vi.restoreAllMocks();
    vi.mocked(refreshControlUiServiceWorker).mockReset();
  },
  () => mounted.forEach((panel) => panel.closeTerminalPanel()),
);
beforeEach(() => {
  verifyDisposal = false;
  vi.mocked(refreshControlUiServiceWorker).mockResolvedValue(false);
  createTerminal.mockImplementation(async () => {
    const terminal = createTerminalController();
    terminals.push(terminal);
    return terminal;
  });
});
function mountPanel(
  client: TerminalGatewayClient,
  props: Partial<OpenClawTerminalPanel> = {},
  open = true,
) {
  const panel = mount(PANEL_TAG, { client, available: true, ...props }, open);
  mounted.push(panel);
  return panel;
}
function attachResult(sessionId: string, buffer = "ready") {
  return { ...terminalOpenResult(sessionId), buffer, seq: buffer.length };
}
const savedIds = () => JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]") as string[];

function updatePanel(panel: OpenClawTerminalPanel, props: Partial<OpenClawTerminalPanel>) {
  Object.assign(panel, props);
  return panel.updateComplete;
}

describe("restore", () => {
  type PendingAttach = ReturnType<typeof createDeferred<ReturnType<typeof attachResult>>> & {
    sessionId: string;
  };

  function createGateway(sessionIds = ["session-a", "session-b"]) {
    const attaches: PendingAttach[] = [];
    const admissions: ReturnType<typeof createDeferred<PendingAttach>>[] = [];
    const admission = (index: number) => (admissions[index] ??= createDeferred<PendingAttach>());
    const list = vi.fn(async () => ({
      sessions: sessionIds.map((sessionId) => ({
        ...terminalOpenResult(sessionId),
        attached: false,
        createdAtMs: 1,
      })),
    }));
    const gateway = eventGateway((method, params) => {
      if (method === "terminal.list") {
        return list();
      }
      if (method === "terminal.attach") {
        const { sessionId } = params as { sessionId: string };
        const reply = { ...createDeferred<ReturnType<typeof attachResult>>(), sessionId };
        attaches.push(reply);
        releaseResponses.push(() => reply.resolve(attachResult(sessionId)));
        admission(attaches.length - 1).resolve(reply);
        return reply.promise;
      }
      return method === "terminal.open" ? terminalOpenResult("replacement") : { ok: true };
    });
    return {
      client: gateway.client,
      list,
      attaches,
      admitted: (index: number) => admission(index).promise,
      calls: gateway.calls,
      emit: (event: Parameters<Parameters<TerminalGatewayClient["addEventListener"]>[0]>[0]) => {
        gateway.emit(event.event, event.payload);
      },
    };
  }

  async function waitForAttach(
    gateway: ReturnType<typeof createGateway>,
    index: number,
    signal: AbortSignal,
  ) {
    const reply = await withinTest(gateway.admitted(index), signal);
    expect(gateway.attaches).toHaveLength(index + 1);
    return reply;
  }

  async function startInterruptedRestore(signal: AbortSignal) {
    const gateway = createGateway();
    const writes = recordSessionWrites();
    const panel = mountPanel(gateway.client);
    const first = await waitForAttach(gateway, 0, signal);
    first.resolve(attachResult(first.sessionId));
    const second = await waitForAttach(gateway, 1, signal);
    await panel.updateComplete;
    expect(writes).toContainEqual(["session-a", "session-b"]);
    for (const ids of writes) {
      expect(ids).toEqual(["session-a", "session-b"]);
    }
    expect(savedIds()).toEqual(["session-a", "session-b"]);
    expect(panel.hostedTabs.map((tab) => tab.className)).toEqual(["is-live", "is-connecting"]);
    writes.length = 0;
    return { gateway, panel, second, writes };
  }

  function recordSessionWrites() {
    const writes: string[][] = [];
    const setItem = sessionStorage.setItem.bind(sessionStorage);
    vi.spyOn(sessionStorage, "setItem").mockImplementation((key, value) => {
      if (key === STORAGE_KEY) {
        writes.push(JSON.parse(value) as string[]);
      }
      setItem(key, value);
    });
    return writes;
  }

  beforeEach(() => {
    verifyDisposal = true;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(["session-a", "session-b"]));
  });
  it.for(["pointerdown", "keydown"])(
    "preserves newer focus and selection after %s",
    async (eventType, { signal }) => {
      const policies: Array<(() => boolean) | undefined> = [];
      createTerminal.mockImplementation(async (_options, shouldFocusOnOpen?: () => boolean) => {
        policies.push(shouldFocusOnOpen);
        return createTerminalController();
      });
      const gateway = createGateway();
      const panel = mountPanel(gateway.client);
      const first = await waitForAttach(gateway, 0, signal);
      const firstId = panel.activeHostedTabId;
      expect(firstId).not.toBeNull();
      expect(policies[0]?.()).toBe(true);
      const external = document.body.appendChild(document.createElement("input"));
      external.focus();
      external.dispatchEvent(
        eventType === "keydown"
          ? new KeyboardEvent(eventType, { key: "ArrowDown", bubbles: true })
          : new Event(eventType, { bubbles: true }),
      );
      expect(policies[0]?.()).toBe(false);
      first.resolve(attachResult(first.sessionId));
      const second = await waitForAttach(gateway, 1, signal);
      expect(policies[1]?.()).toBe(false);
      expect(panel.activeHostedTabId).toBe(firstId);
      second.resolve(attachResult(second.sessionId));
      await waitForPanelReady(panel);
      expect(document.activeElement).toBe(external);
      const next = panel.hostedTabs[1]!;
      const terminal = await createTerminal.mock.results[1]!.value;
      const focus = vi.spyOn(terminal.terminal, "focus").mockClear();
      panel.selectHostedTab(next.id);
      await panel.updateComplete;
      await waitForFast(() => expect(focus).toHaveBeenCalledOnce());
      expect(panel.activeHostedTabId).toBe(next.id);
    },
  );

  it.for([false, true])(
    "removes restore input observers (unmounted=%s)",
    async (unmounted, { signal }) => {
      const added = vi.spyOn(document, "addEventListener");
      const removed = vi.spyOn(document, "removeEventListener");
      const gateway = createGateway();
      const panel = mountPanel(gateway.client);
      const first = await waitForAttach(gateway, 0, signal);
      const handler = added.mock.calls.find(
        ([type, listener, capture]) =>
          type === "pointerdown" &&
          capture === true &&
          added.mock.calls.some(
            ([other, callback, options]) =>
              other === "keydown" && callback === listener && options === true,
          ),
      )?.[1];
      expect(handler).toBeDefined();
      if (unmounted) {
        panel.remove();
        await waitForFast(() => expect(panel.hostedTabs).toHaveLength(0));
        first.resolve(attachResult(first.sessionId));
      } else {
        first.resolve(attachResult(first.sessionId));
        const second = await waitForAttach(gateway, 1, signal);
        second.resolve(attachResult(second.sessionId));
        await waitForPanelReady(panel);
      }
      expect(removed).toHaveBeenCalledWith("pointerdown", handler, true);
      expect(removed).toHaveBeenCalledWith("keydown", handler, true);
    },
  );

  it.for([
    { closeIndex: 0, closed: "session-a", remaining: "session-b" },
    { closeIndex: 1, closed: "session-b", remaining: "session-a" },
  ])(
    "retires $closed while the second attach is pending",
    async ({ closeIndex, closed, remaining }, { signal }) => {
      const { gateway, panel, second } = await startInterruptedRestore(signal);
      const close = panel.querySelectorAll<HTMLButtonElement>(".tabstrip-tab__close")[closeIndex];
      expect(close).toBeDefined();
      close!.click();
      expect(savedIds()).toEqual([remaining]);
      if (closeIndex === 1) {
        expect(gateway.calls("terminal.close")).toEqual([]);
      }

      second.resolve(attachResult(second.sessionId));
      await waitForPanelReady(panel);
      expect(gateway.calls("terminal.close")).toContainEqual({ sessionId: closed });
      expect(panel.hostedTabs).toMatchObject([{ className: "is-live" }]);
      expect(savedIds()).toEqual([remaining]);
    },
  );

  it("opens a queued catalog after cancelling restore", async ({ signal }) => {
    const catalog = {
      catalogId: "catalog-a",
      hostId: "host-a",
      threadId: "thread-a",
      sourceHomeId: "synthetic-home-secondary",
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(["session-a"]));
    queueCatalog(catalog, "agent-a");
    const gateway = createGateway(["session-a"]);
    const panel = mountPanel(gateway.client);
    const first = await waitForAttach(gateway, 0, signal);
    panelButton(panel, ".tabstrip-tab__close")!.click();
    first.resolve(attachResult(first.sessionId));
    await waitForFast(() => expect(gateway.calls("terminal.open")).toHaveLength(1));
    gateway.emit({
      event: "terminal.data",
      payload: { sessionId: "replacement", seq: 5, data: "ready" },
    });
    await waitForPanelReady(panel);
    expect(gateway.calls("terminal.open")).toContainEqual({
      agentId: "agent-a",
      catalog,
      cols: 100,
      rows: 30,
    });
    expect(panel.terminalPanelOpen).toBe(true);
    expect(panel.querySelector(".tp-error")).toBeNull();
    expect(savedIds()).toEqual(["replacement"]);
  });

  it.for(["resolve", "reject"] as const)(
    "keeps a queued attach visible after restore cancellation (follower %s)",
    async (outcome, { signal }) => {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(["session-a"]));
      const gateway = createGateway();
      const panel = mountPanel(gateway.client);
      const first = await waitForAttach(gateway, 0, signal);
      window.dispatchEvent(
        new CustomEvent("openclaw:terminal-toggle", {
          detail: { open: true, terminalSessionId: "session-b" },
        }),
      );
      panelButton(panel, ".tabstrip-tab__close")!.click();
      first.resolve(attachResult(first.sessionId));
      const follower = await waitForAttach(gateway, 1, signal);
      if (outcome === "resolve") {
        follower.resolve(attachResult(follower.sessionId));
      } else {
        follower.reject(new Error("queued attach failed"));
      }
      await waitForPanelReady(panel);
      expect(panel.terminalPanelOpen).toBe(true);
      expect(gateway.attaches.map((request) => request.sessionId)).toEqual([
        "session-a",
        "session-b",
      ]);
      expect(gateway.calls("terminal.open")).toEqual([]);
      expect(savedIds()).toEqual(outcome === "resolve" ? ["session-b"] : []);
      if (outcome === "resolve") {
        expect(panel.querySelector(".tp-error")).toBeNull();
      } else {
        expect(panel.querySelector(".tp-error")?.textContent).toContain("queued attach failed");
      }
    },
  );

  it("does not resurrect an exit received before adoption", async ({ signal }) => {
    const { gateway, panel, second, writes } = await startInterruptedRestore(signal);
    gateway.emit({
      event: "terminal.exit",
      payload: { sessionId: "session-b", exitCode: 0, reason: "exited" },
    });
    second.resolve(attachResult(second.sessionId));
    await waitForPanelReady(panel);

    expect(writes).toContainEqual(["session-a"]);
    expect(panel.hostedTabs[1]).toMatchObject({ className: "is-exited" });
    expect(savedIds()).toEqual(["session-a"]);
    expect(gateway.calls("terminal.resize")).not.toContainEqual({
      sessionId: "session-b",
      cols: 100,
      rows: 30,
    });
  });

  it("retires an adopted session during pending restore", async ({ signal }) => {
    const { gateway, panel, second } = await startInterruptedRestore(signal);
    gateway.emit({
      event: "terminal.exit",
      payload: { sessionId: "session-a", exitCode: 0, reason: "exited" },
    });
    expect(savedIds()).toEqual(["session-b"]);
    second.resolve(attachResult(second.sessionId));
    await waitForPanelReady(panel);
    expect(savedIds()).toEqual(["session-b"]);
  });

  it.for([
    { transition: "same-client reconnect", completion: "reject" },
    { transition: "replacement client", completion: "resolve" },
    { transition: "replacement host", completion: "resolve" },
  ])(
    "keeps the restore set across $transition and a stale attach $completion",
    async ({ transition, completion }, { signal }) => {
      const { gateway, panel, second, writes } = await startInterruptedRestore(signal);
      const currentGateway = transition === "same-client reconnect" ? gateway : createGateway();
      let current = panel;
      if (transition === "replacement host") {
        panel.remove();
        current = mountPanel(currentGateway.client);
      } else {
        if (transition === "same-client reconnect") {
          await updatePanel(panel, { client: null, available: false });
          await waitForFast(() => expect(panel.hostedTabs).toHaveLength(0));
        }

        await updatePanel(panel, { client: currentGateway.client, available: true });
      }
      await waitForFast(() => expect(panel.hostedTabs).toHaveLength(0));
      expect(writes).toHaveLength(0);
      expect(savedIds()).toEqual(["session-a", "session-b"]);

      if (completion === "resolve") {
        second.resolve(attachResult(second.sessionId));
      } else {
        second.reject(new Error("old connection closed"));
      }
      const firstIndex = currentGateway === gateway ? 2 : 0;
      const restoredFirst = await waitForAttach(currentGateway, firstIndex, signal);
      expect(writes).toHaveLength(0);
      restoredFirst.resolve(attachResult(restoredFirst.sessionId));
      const restoredSecond = await waitForAttach(currentGateway, firstIndex + 1, signal);
      expect(savedIds()).toEqual(["session-a", "session-b"]);
      restoredSecond.resolve(attachResult(restoredSecond.sessionId));
      await waitForPanelReady(current);
      expect(current.hostedTabs.map((tab) => tab.className)).toEqual(["is-live", "is-live"]);
      expect(savedIds()).toEqual(["session-a", "session-b"]);
      expect(currentGateway.calls("terminal.open")).toEqual([]);
      expect(gateway.calls("terminal.close")).toEqual([]);
    },
  );

  it.for(["list", "attach"] as const)(
    "retains ids after failed %s without opening a replacement",
    async (stage, { signal }) => {
      const gateway = createGateway();
      const error = new Error("gateway temporarily unavailable");
      if (stage === "list") {
        gateway.list.mockRejectedValueOnce(error);
      }
      const panel = mountPanel(gateway.client);
      if (stage === "attach") {
        const first = await waitForAttach(gateway, 0, signal);
        first.reject(error);
      }
      await waitForFast(() =>
        expect(panel.querySelector('.tp-error[role="alert"]')?.textContent).toMatch(/attach/i),
      );
      expect(savedIds()).toEqual(["session-a", "session-b"]);
      expect(gateway.attaches).toHaveLength(stage === "list" ? 0 : 1);
      expect(panel.hostedTabs).toEqual([]);
      expect(gateway.calls("terminal.open")).toEqual([]);
      await waitForPanelReady(panel);
    },
  );
});

describe("pending cancellation", () => {
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
      const panel = mountPanel(
        client,
        {
          page,
          fullscreen: page,
          embedded: page,
          routeTarget: kind === "attach" ? { sessionId: "pending-session" } : null,
        },
        false,
      );
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

        await updatePanel(panel, { client: null, available: false });

        await updatePanel(panel, { client, available: true });
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
      const healthyController = createTerminalController();
      createTerminal.mockResolvedValueOnce(healthyController);
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
      const panel = mountPanel(client, {}, false);
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
        await updatePanel(panel, { client: null, available: false });
        await waitForFast(() => expect(healthyController.dispose).toHaveBeenCalledOnce());

        await updatePanel(panel, { client, available: true });
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

describe("exit", () => {
  type Exit = { reason?: string; exitCode: number | null; signal?: number | null; error?: string };
  const normalExit: Exit = { reason: "process_exit", exitCode: 0, signal: null };

  async function mountExitedSession(options: { fullscreen?: boolean; earlyExit?: Exit } = {}) {
    let sequence = 0;
    const { client, request, emit } = eventGateway((method) => {
      if (method === "terminal.open") {
        const sessionId = `session-${++sequence}`;
        if (options.earlyExit) {
          emit("terminal.exit", { sessionId, ...options.earlyExit });
        }
        return terminalOpenResult(sessionId);
      }
      return method === "terminal.list" ? { sessions: [] } : { ok: true };
    });
    const panel = mountPanel(
      client,
      { fullscreen: options.fullscreen ?? false },
      !options.fullscreen,
    );
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("terminal.open", expect.anything(), expect.anything()),
    );
    await waitForFast(() => expect(panel.querySelector(".tp-connecting")).toBeNull());
    await panel.updateComplete;
    return { panel, controllers: terminals, request, emit };
  }

  it("retires shells independently, closes the last without an RPC, and reopens fresh", async () => {
    const { panel, controllers, request, emit } = await mountExitedSession();
    const remaining = panel.activeHostedTabId;
    togglePanel(panel, { newSession: true });
    await waitForFast(() => expect(panel.hostedTabs).toHaveLength(2));
    await waitForFast(() => expect(panel.hostedTabs[1]?.className).toBe("is-live"));
    emit("terminal.exit", { sessionId: "session-2", ...normalExit });
    await panel.updateComplete;
    expect(panel).toMatchObject({
      hostedTabs: [expect.anything()],
      activeHostedTabId: remaining,
      terminalPanelOpen: true,
    });
    emit("terminal.exit", { sessionId: "session-1", ...normalExit });
    await panel.updateComplete;
    expect(panel).toMatchObject({ hostedTabs: [], terminalPanelOpen: false });
    expect(controllers[0]!.dispose).toHaveBeenCalledOnce();
    expect(request.mock.calls.some(([method]) => method === "terminal.close")).toBe(false);
    expect(savedIds()).toEqual([]);
    expect(document.documentElement.style.getPropertyValue("--oc-terminal-reserve-bottom")).toBe(
      "0px",
    );
    panel.toggle();
    await waitForFast(() => expect(panel.hostedTabs[0]?.className).toBe("is-live"));
    expect(request.mock.calls.filter(([method]) => method === "terminal.open")).toHaveLength(3);
  });

  it.each([
    { reason: "process_exit", exitCode: 7 },
    { reason: "error", exitCode: 7 },
    { reason: "process_exit", exitCode: 0, signal: 15 },
    { reason: "process_exit", exitCode: null },
    { reason: "error", exitCode: 0, error: "PTY failed" },
    { reason: "process_exit", exitCode: 0, error: "Output failed" },
    { reason: "detached", exitCode: 0 },
    { reason: "disconnected", exitCode: null },
    { reason: "closed", exitCode: 0 },
    { exitCode: 0 },
  ] satisfies Exit[])(
    "preserves output for $reason / $exitCode / $signal / $error",
    async (exit) => {
      const { panel, controllers, request, emit } = await mountExitedSession();
      const data = "Diagnostic output\r\n";
      emit("terminal.data", { sessionId: "session-1", seq: data.length, data });
      emit("terminal.exit", { sessionId: "session-1", ...exit });
      await panel.updateComplete;
      expect(panel).toMatchObject({
        hostedTabs: [expect.objectContaining({ className: "is-exited" })],
        terminalPanelOpen: true,
      });
      expect(controllers[0]!.dispose).not.toHaveBeenCalled();
      expect(controllers[0]!.write).toHaveBeenCalledWith(new TextEncoder().encode(data));
      await updatePanel(panel, { gatewayConnected: false });
      expect(panel.hostedTabs[0]?.closeDisabled).toBe(false);
      const close = panelButton(panel, ".tabstrip-tab__close")!;
      expect(close.disabled).toBe(false);
      close.click();
      await panel.updateComplete;
      expect(panel.hostedTabs).toEqual([]);
      expect(request.mock.calls.some(([method]) => method === "terminal.close")).toBe(false);
    },
  );

  it("keeps the fullscreen new-shell control reachable after a normal exit", async () => {
    const { panel, emit } = await mountExitedSession({ fullscreen: true });
    emit("terminal.exit", { sessionId: "session-1", ...normalExit });
    await panel.updateComplete;
    expect(panel).toMatchObject({ hostedTabs: [], terminalPanelOpen: true });
    expect(panel.querySelector(".tabstrip-new")).not.toBeNull();
  });

  it("does not resurrect an early normal exit or open a replacement shell", async () => {
    const { panel, request } = await mountExitedSession({ earlyExit: normalExit });
    expect(panel).toMatchObject({ hostedTabs: [], terminalPanelOpen: false });
    expect(request.mock.calls.filter(([method]) => method === "terminal.open")).toHaveLength(1);
  });
});

describe("same-client resume", () => {
  it("settles availability changes while offline without repeatedly suspending the terminal", async () => {
    const terminal = createTerminalController();
    createTerminal.mockResolvedValue(terminal);
    const request = createGatewayRequestMock((method) =>
      method === "terminal.open" ? terminalOpenResult("retained") : { ok: true },
    );
    const panel = mountPanel(createTestGatewayClient(request));
    await waitForFast(() => expect(savedIds()).toEqual(["retained"]));

    await updatePanel(panel, { gatewayConnected: false });
    await waitForFast(() => expect(terminal.setReadOnly).toHaveBeenCalledWith(true));
    await panel.updateComplete;
    expect(terminal.dispose).not.toHaveBeenCalled();

    request.mockClear();

    for (const available of [false, true]) {
      await updatePanel(panel, { available });
      await vi.dynamicImportSettled();
      await panel.updateComplete;
      expect(terminal.dispose).toHaveBeenCalledOnce();
      expect(panel).toMatchObject({ hostedTabs: [], terminalPanelOpen: available });
      expect(panel.querySelector(".tp") !== null).toBe(available);
      expect(request).not.toHaveBeenCalled();
    }
  });

  it("holds retained PTYs and queued actions behind the same-client reconnect refresh", async () => {
    const refresh = createDeferred<boolean>();
    const reattach = createDeferred<TerminalAttachResult>();
    const terminal = createTerminalController();
    vi.mocked(refreshControlUiServiceWorker).mockReturnValue(refresh.promise);
    createTerminal
      .mockImplementation(async () => createTerminalController())
      .mockResolvedValueOnce(terminal);
    let opened = 0;
    const request = createGatewayRequestMock((method) => {
      if (method === "terminal.open") {
        return terminalOpenResult(++opened === 1 ? "retained" : "queued");
      }
      if (method === "terminal.attach") {
        return reattach.promise;
      }
      return { ok: true };
    });
    const panel = mountPanel(createTestGatewayClient(request));
    await waitForFast(() => expect(savedIds()).toEqual(["retained"]));
    const tabId = panel.hostedTabs[0]!.id;
    const terminalHost = createTerminal.mock.calls[0]![0].parent;

    await updatePanel(panel, { gatewayConnected: false });
    await waitForFast(() => expect(terminal.setReadOnly).toHaveBeenCalledWith(true));
    togglePanel(panel, { open: true, newSession: true });
    await panel.updateComplete;
    expect(opened).toBe(1);

    await updatePanel(panel, { gatewayConnected: true });
    await waitForFast(() => expect(refreshControlUiServiceWorker).toHaveBeenCalledOnce());
    expect(request.mock.calls.filter(([method]) => method === "terminal.attach")).toEqual([]);
    expect(opened).toBe(1);
    expect(panel.hostedTabs.map((tab) => tab.id)).toEqual([tabId]);
    expect(terminal.dispose).not.toHaveBeenCalled();

    refresh.resolve(false);
    await waitForFast(() =>
      expect(request.mock.calls.filter(([method]) => method === "terminal.attach")).toHaveLength(1),
    );
    expect(opened).toBe(1);
    expect(terminal.setReadOnly).toHaveBeenLastCalledWith(true);
    reattach.resolve({ ...terminalOpenResult("retained"), buffer: "", seq: 0 });
    await waitForFast(() => {
      expect(savedIds()).toEqual(["retained", "queued"]);
      expect(terminal.setReadOnly).toHaveBeenLastCalledWith(false);
    });
    expect(request.mock.calls.filter(([method]) => method === "terminal.attach")).toHaveLength(1);
    expect(opened).toBe(2);
    expect(panel.hostedTabs[0]?.id).toBe(tabId);
    expect(panel.contains(terminalHost)).toBe(true);
    expect(terminal.dispose).not.toHaveBeenCalled();
    expect(panel.querySelector(".tp-error")).toBeNull();
  });

  it("exits a confirmed missing retained PTY without leaving its surviving tab read-only", async () => {
    vi.mocked(refreshControlUiServiceWorker).mockResolvedValue(false);
    const expiredTerminal = createTerminalController();
    const survivingTerminal = createTerminalController();
    createTerminal.mockResolvedValueOnce(expiredTerminal).mockResolvedValueOnce(survivingTerminal);
    let opened = 0;
    const request = createGatewayRequestMock((method, params) => {
      if (method === "terminal.open") {
        return terminalOpenResult(++opened === 1 ? "expired" : "survivor");
      }
      if (method === "terminal.attach") {
        return isRecord(params) && params.sessionId === "expired"
          ? Promise.reject(new Error('unknown terminal session "expired"'))
          : { ...terminalOpenResult("survivor"), buffer: "", seq: 0 };
      }
      if (method === "terminal.list") {
        return {
          sessions: [{ ...terminalOpenResult("survivor"), attached: true, createdAtMs: 1 }],
        };
      }
      return { ok: true };
    });
    const panel = mountPanel(createTestGatewayClient(request));
    await waitForFast(() => expect(panel.hostedTabs[0]?.className).toBe("is-live"));
    panel.querySelector<HTMLButtonElement>('[aria-label="New terminal session"]')!.click();
    await panel.updateComplete;
    await waitForFast(() => expect(panel.hostedTabs[1]?.className).toBe("is-live"));
    const tabIds = panel.hostedTabs.map((tab) => tab.id);
    expect(savedIds()).toEqual(["expired", "survivor"]);

    await updatePanel(panel, { gatewayConnected: false });
    await waitForFast(() => {
      expect(expiredTerminal.setReadOnly).toHaveBeenLastCalledWith(true);
      expect(survivingTerminal.setReadOnly).toHaveBeenLastCalledWith(true);
    });

    await updatePanel(panel, { gatewayConnected: true });
    await waitForFast(() => {
      expect(survivingTerminal.setReadOnly).toHaveBeenLastCalledWith(false);
      expect(panel.hostedTabs.map((tab) => tab.className)).toEqual(["is-exited", "is-live"]);
    });
    expect(expiredTerminal.setReadOnly).toHaveBeenLastCalledWith(true);
    expect(panel.hostedTabs.map((tab) => tab.id)).toEqual(tabIds);
    expect(expiredTerminal.dispose).not.toHaveBeenCalled();
    expect(survivingTerminal.dispose).not.toHaveBeenCalled();
    expect(savedIds()).toEqual(["survivor"]);
    expect(panel.querySelector(".tp-error")).toBeNull();
  });
});
