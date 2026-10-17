/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.ts";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  createTerminalController,
  createTestTerminalPanel,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";
import type { OpenClawTerminalPanel } from "./terminal-panel.ts";

vi.mock("../../app/sw-refresh.runtime.ts", () => ({
  refreshControlUiServiceWorker: vi.fn(async () => false),
}));

const STORAGE_KEY = "openclaw.terminal.sessions.v1";
const createTerminal: CreateGhosttyTerminalMock = vi.fn();
const PANEL_TAG = defineTestTerminalPanelElement(createTerminal);
const mounted: OpenClawTerminalPanel[] = [];

function attachResult(sessionId: string) {
  return { ...terminalOpenResult(sessionId), buffer: "ready", seq: 5 };
}

type PendingAttach = ReturnType<typeof createDeferred<ReturnType<typeof attachResult>>> & {
  sessionId: string;
};
const pendingAttaches: PendingAttach[] = [];

function createGateway(sessionIds = ["session-a", "session-b"]) {
  const attaches: PendingAttach[] = [];
  const admissions = new Map<number, ReturnType<typeof createDeferred<PendingAttach>>>();
  const admission = (index: number) => {
    let gate = admissions.get(index);
    if (!gate) {
      gate = createDeferred<PendingAttach>();
      admissions.set(index, gate);
    }
    return gate;
  };
  const requests: Array<{ method: string; params: unknown }> = [];
  const listeners = new Set<Parameters<TerminalGatewayClient["addEventListener"]>[0]>();
  const list = vi.fn(async () => ({
    sessions: sessionIds.map((sessionId) => ({
      ...terminalOpenResult(sessionId),
      attached: false,
      createdAtMs: 1,
    })),
  }));
  const client: TerminalGatewayClient = {
    forceReconnect: vi.fn(),
    request: <T>(method: string, params?: unknown) => {
      requests.push({ method, params });
      if (method === "terminal.list") {
        return list() as Promise<T>;
      }
      if (method === "terminal.attach") {
        const { sessionId } = params as { sessionId: string };
        const reply = { ...createDeferred<ReturnType<typeof attachResult>>(), sessionId };
        attaches.push(reply);
        pendingAttaches.push(reply);
        admission(attaches.length - 1).resolve(reply);
        return reply.promise as Promise<T>;
      }
      return Promise.resolve(
        method === "terminal.open" ? terminalOpenResult("replacement") : {},
      ) as Promise<T>;
    },
    addEventListener: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    client,
    list,
    attaches,
    admitted: (index: number) => admission(index).promise,
    requests,
    emit: (event: Parameters<Parameters<TerminalGatewayClient["addEventListener"]>[0]>[0]) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

function mountPanel(
  client: TerminalGatewayClient,
  options: { page?: boolean; open?: boolean } = {},
) {
  const panel = createTestTerminalPanel(PANEL_TAG);
  panel.client = client;
  panel.available = true;
  panel.page = panel.fullscreen = panel.embedded = options.page === true;
  mounted.push(panel);
  document.body.append(panel);
  if (!panel.terminalPanelOpen && options.open !== false) {
    panel.toggle();
  }
  return { panel };
}

function savedIds(): string[] {
  return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]") as string[];
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
  const { panel } = mountPanel(gateway.client);
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

async function settled(panel: OpenClawTerminalPanel) {
  await waitForFast(() =>
    expect(panel.querySelector<HTMLButtonElement>(".tabstrip-new")?.disabled).toBe(false),
  );
}

describe("terminal persisted restore", () => {
  beforeEach(async () => {
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("sessionStorage", createStorageMock());
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(["session-a", "session-b"]));
    createTerminal.mockImplementation(async () => createTerminalController());
    await i18n.setLocale("en");
  });

  afterEach(async () => {
    for (const panel of mounted) {
      panel.closeTerminalPanel();
    }
    document.body.replaceChildren();
    await Promise.resolve();
    for (const reply of pendingAttaches) {
      reply.resolve(attachResult(reply.sessionId));
    }
    // The fixture waits for each renderer's public disposal, including delayed attach replies.
    for (const result of createTerminal.mock.results) {
      if (result.type === "return") {
        const terminal = await result.value;
        await waitForFast(() => expect(terminal.dispose).toHaveBeenCalled());
      }
    }
    mounted.length = 0;
    pendingAttaches.length = 0;
    createTerminal.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  it.for(["pointerdown", "keydown"])(
    "preserves newer focus and selection after %s during restore",
    async (eventType, { signal }) => {
      const policies: Array<(() => boolean) | undefined> = [];
      createTerminal.mockImplementation(async (_options, shouldFocusOnOpen?: () => boolean) => {
        policies.push(shouldFocusOnOpen);
        return createTerminalController();
      });
      const gateway = createGateway();
      const { panel } = mountPanel(gateway.client);
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
      await settled(panel);
      expect(document.activeElement).toBe(external);
      const next = panel.hostedTabs[1];
      if (!next) {
        throw new Error("second terminal not restored");
      }
      const terminal = await createTerminal.mock.results[1]!.value;
      const focus = vi.spyOn(terminal.terminal, "focus").mockClear();
      panel.selectHostedTab(next.id);
      await panel.updateComplete;
      await waitForFast(() => expect(focus).toHaveBeenCalledOnce());
      expect(panel.activeHostedTabId).toBe(next.id);
    },
  );

  it.for([false, true])(
    "removes restore input observers when finished (unmounted=%s)",
    async (unmounted, { signal }) => {
      const added = vi.spyOn(document, "addEventListener");
      const removed = vi.spyOn(document, "removeEventListener");
      const gateway = createGateway();
      const { panel } = mountPanel(gateway.client);
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
      if (!handler) {
        throw new Error("restore input observer missing");
      }
      if (unmounted) {
        panel.remove();
        await waitForFast(() => expect(panel.hostedTabs).toHaveLength(0));
        first.resolve(attachResult(first.sessionId));
      } else {
        first.resolve(attachResult(first.sessionId));
        const second = await waitForAttach(gateway, 1, signal);
        second.resolve(attachResult(second.sessionId));
        await settled(panel);
      }
      expect(removed).toHaveBeenCalledWith("pointerdown", handler, true);
      expect(removed).toHaveBeenCalledWith("keydown", handler, true);
    },
  );

  it.for([
    { closeIndex: 0, closed: "session-a", remaining: "session-b" },
    { closeIndex: 1, closed: "session-b", remaining: "session-a" },
  ])(
    "retires a deliberate close of $closed while the second attach is pending",
    async ({ closeIndex, closed, remaining }, { signal }) => {
      const { gateway, panel, second } = await startInterruptedRestore(signal);
      const close = panel.querySelectorAll<HTMLButtonElement>(".tabstrip-tab__close")[closeIndex];
      expect(close).toBeDefined();
      close!.click();
      expect(savedIds()).toEqual([remaining]);
      if (closeIndex === 1) {
        expect(gateway.requests.some(({ method }) => method === "terminal.close")).toBe(false);
      }

      second.resolve(attachResult(second.sessionId));
      await settled(panel);
      expect(gateway.requests).toContainEqual({
        method: "terminal.close",
        params: { sessionId: closed },
      });
      expect(panel.hostedTabs).toHaveLength(1);
      expect(panel.hostedTabs[0]?.className).toBe("is-live");
      expect(savedIds()).toEqual([remaining]);
    },
  );

  it("opens a persisted catalog request after its restored tab is cancelled", async ({
    signal,
  }) => {
    const catalog = {
      catalogId: "catalog-a",
      hostId: "host-a",
      threadId: "thread-a",
      sourceHomeId: "synthetic-home-secondary",
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(["session-a"]));
    sessionStorage.setItem(
      "openclaw.terminal.actions.v1",
      JSON.stringify([{ kind: "catalog", agentId: "agent-a", catalog }]),
    );
    const gateway = createGateway(["session-a"]);
    const { panel } = mountPanel(gateway.client);
    const first = await waitForAttach(gateway, 0, signal);
    panel.querySelector<HTMLButtonElement>(".tabstrip-tab__close")!.click();
    first.resolve(attachResult(first.sessionId));
    await waitForFast(() =>
      expect(gateway.requests.filter(({ method }) => method === "terminal.open")).toHaveLength(1),
    );
    gateway.emit({
      event: "terminal.data",
      payload: { sessionId: "replacement", seq: 5, data: "ready" },
    });
    await waitForFast(() =>
      expect(panel.querySelector<HTMLButtonElement>(".tabstrip-new")?.disabled).toBe(false),
    );
    expect(gateway.requests).toContainEqual({
      method: "terminal.open",
      params: { agentId: "agent-a", catalog, cols: 100, rows: 30 },
    });
    expect(panel.terminalPanelOpen).toBe(true);
    expect(panel.querySelector(".tp-error")).toBeNull();
    expect(savedIds()).toEqual(["replacement"]);
  });

  it.for(["resolve", "reject"] as const)(
    "keeps a queued attach visible after a cancelled restore and follower %s",
    async (outcome, { signal }) => {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(["session-a"]));
      const gateway = createGateway();
      const { panel } = mountPanel(gateway.client);
      const first = await waitForAttach(gateway, 0, signal);
      window.dispatchEvent(
        new CustomEvent("openclaw:terminal-toggle", {
          detail: { open: true, terminalSessionId: "session-b" },
        }),
      );
      panel.querySelector<HTMLButtonElement>(".tabstrip-tab__close")!.click();
      first.resolve(attachResult(first.sessionId));
      const follower = await waitForAttach(gateway, 1, signal);
      if (outcome === "resolve") {
        follower.resolve(attachResult(follower.sessionId));
      } else {
        follower.reject(new Error("queued attach failed"));
      }
      await waitForFast(() =>
        expect(panel.querySelector<HTMLButtonElement>(".tabstrip-new")?.disabled).toBe(false),
      );
      expect(panel.terminalPanelOpen).toBe(true);
      expect(gateway.attaches.map((request) => request.sessionId)).toEqual([
        "session-a",
        "session-b",
      ]);
      expect(gateway.requests.filter((request) => request.method === "terminal.open")).toEqual([]);
      expect(savedIds()).toEqual(outcome === "resolve" ? ["session-b"] : []);
      if (outcome === "resolve") {
        expect(panel.querySelector(".tp-error")).toBeNull();
      } else {
        expect(panel.querySelector(".tp-error")?.textContent).toContain("queued attach failed");
      }
    },
  );

  it("retires an exit delivered before adoption without resurrecting its id on attach completion", async ({
    signal,
  }) => {
    const { gateway, panel, second, writes } = await startInterruptedRestore(signal);
    gateway.emit({
      event: "terminal.exit",
      payload: { sessionId: "session-b", exitCode: 0, reason: "exited" },
    });
    second.resolve(attachResult(second.sessionId));
    await settled(panel);

    expect(writes).toContainEqual(["session-a"]);
    expect(panel.hostedTabs[1]).toMatchObject({ className: "is-exited" });
    expect(savedIds()).toEqual(["session-a"]);
    expect(gateway.requests).not.toContainEqual({
      method: "terminal.resize",
      params: { sessionId: "session-b", cols: 100, rows: 30 },
    });
  });

  it("removes an adopted session that exits while another restore is pending", async ({
    signal,
  }) => {
    const { gateway, panel, second } = await startInterruptedRestore(signal);
    gateway.emit({
      event: "terminal.exit",
      payload: { sessionId: "session-a", exitCode: 0, reason: "exited" },
    });
    expect(savedIds()).toEqual(["session-b"]);
    second.resolve(attachResult(second.sessionId));
    await settled(panel);
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
      let current = { panel };
      if (transition === "replacement host") {
        panel.remove();
        current = mountPanel(currentGateway.client);
      } else {
        if (transition === "same-client reconnect") {
          panel.client = null;
          panel.available = false;
          await panel.updateComplete;
          await waitForFast(() => expect(panel.hostedTabs).toHaveLength(0));
        }
        panel.client = currentGateway.client;
        panel.available = true;
        await panel.updateComplete;
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
      await settled(current.panel);
      expect(current.panel.hostedTabs.map((tab) => tab.className)).toEqual(["is-live", "is-live"]);
      expect(savedIds()).toEqual(["session-a", "session-b"]);
      expect(currentGateway.requests.some(({ method }) => method === "terminal.open")).toBe(false);
      expect(gateway.requests.some(({ method }) => method === "terminal.close")).toBe(false);
    },
  );

  it("prunes a failed list before opening the existing fresh-session fallback", async () => {
    const gateway = createGateway();
    gateway.list.mockRejectedValueOnce(new Error("gateway temporarily unavailable"));
    const { panel } = mountPanel(gateway.client);
    await waitForFast(() => expect(savedIds()).toEqual(["replacement"]));
    expect(gateway.attaches).toHaveLength(0);
    expect(panel.hostedTabs).toHaveLength(1);
    await settled(panel);
  });
});
