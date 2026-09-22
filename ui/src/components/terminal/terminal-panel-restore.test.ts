/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { i18n } from "../../i18n/index.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import type { TerminalPanelSessionController } from "./terminal-panel-session-controller.ts";
import {
  createTerminalController,
  defineTestTerminalPanelElement,
  terminalOpenResult,
  type CreateGhosttyTerminalMock,
} from "./terminal-panel.test-support.ts";
import type { OpenClawTerminalPanel } from "./terminal-panel.ts";
import { TerminalIntentQueue } from "./terminal-pending-actions.ts";
import type { TerminalTaskQueue } from "./terminal-task-queue.ts";

vi.mock("../../app/sw-refresh.runtime.ts", () => ({
  refreshControlUiServiceWorker: vi.fn(async () => false),
}));

const STORAGE_KEY = "openclaw.terminal.sessions.v1";
const createTerminal: CreateGhosttyTerminalMock = vi.fn();
const PANEL_TAG = defineTestTerminalPanelElement(createTerminal);
const mounted: Array<{
  panel: OpenClawTerminalPanel;
  sessions: TerminalPanelSessionController;
}> = [];

function attachResult(sessionId: string) {
  return { ...terminalOpenResult(sessionId), buffer: "ready", seq: 5 };
}

type PendingAttach = ReturnType<typeof createDeferred<ReturnType<typeof attachResult>>> & {
  sessionId: string;
};
const pendingAttaches: PendingAttach[] = [];

function createGateway(sessionIds = ["session-a", "session-b"]) {
  const attaches: PendingAttach[] = [];
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
  const panel = document.createElement(PANEL_TAG) as OpenClawTerminalPanel;
  panel.client = client;
  panel.available = true;
  panel.page = panel.fullscreen = panel.embedded = options.page === true;
  const sessions = (panel as unknown as { terminalSessions: TerminalPanelSessionController })
    .terminalSessions;
  const mountedPanel = { panel, sessions };
  mounted.push(mountedPanel);
  document.body.append(panel);
  if (!panel.terminalPanelOpen && options.open !== false) {
    panel.toggle();
  }
  return mountedPanel;
}

function savedIds(): string[] {
  return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "[]") as string[];
}

async function waitForAttach(gateway: ReturnType<typeof createGateway>, index: number) {
  await waitForFast(() => expect(gateway.attaches).toHaveLength(index + 1));
  return gateway.attaches[index]!;
}

async function startInterruptedRestore() {
  const gateway = createGateway();
  const { panel, sessions } = mountPanel(gateway.client);
  const first = await waitForAttach(gateway, 0);
  first.resolve(attachResult(first.sessionId));
  const second = await waitForAttach(gateway, 1);
  await panel.updateComplete;
  expect(sessions.tabs.map((tab) => tab.gatewaySessionId)).toEqual(["session-a", ""]);
  return { gateway, panel, sessions, second };
}

function recordSessionWrites(sessions: TerminalPanelSessionController) {
  const writes: Array<{
    ids: string[];
    tabs: Array<{ sessionId: string; status: string }>;
  }> = [];
  const setItem = sessionStorage.setItem.bind(sessionStorage);
  vi.spyOn(sessionStorage, "setItem").mockImplementation((key, value) => {
    if (key === STORAGE_KEY) {
      writes.push({
        ids: JSON.parse(value) as string[],
        tabs: sessions.tabs.map((tab) => ({
          sessionId: tab.gatewaySessionId,
          status: tab.status,
        })),
      });
    }
    setItem(key, value);
  });
  return writes;
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
    for (const { sessions } of mounted) {
      sessions.cancelPendingActions();
    }
    document.body.replaceChildren();
    for (const reply of pendingAttaches) {
      reply.resolve(attachResult(reply.sessionId));
    }
    // Join the existing boot queues after disposal, including replies released by cleanup.
    await Promise.all(
      mounted.map(({ sessions }) =>
        (sessions as unknown as { bootQueue: TerminalTaskQueue }).bootQueue.enqueue(async () => {}),
      ),
    );
    mounted.length = 0;
    pendingAttaches.length = 0;
    createTerminal.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await i18n.setLocale("en");
  });

  it("keeps both ids during replay and a second attach, then restores both after interruption", async () => {
    const gateway = createGateway();
    const { panel, sessions } = mountPanel(gateway.client);
    const writes = recordSessionWrites(sessions);
    const first = await waitForAttach(gateway, 0);
    first.resolve(attachResult(first.sessionId));
    const second = await waitForAttach(gateway, 1);

    expect(writes).toContainEqual({
      ids: ["session-a", "session-b"],
      tabs: [{ sessionId: "", status: "live" }],
    });
    expect(
      writes.every(({ ids }) => JSON.stringify(ids) === JSON.stringify(["session-a", "session-b"])),
    ).toBe(true);
    expect(savedIds()).toEqual(["session-a", "session-b"]);
    expect(sessions.tabs.map((tab) => tab.gatewaySessionId)).toEqual(["session-a", ""]);

    const writeCount = writes.length;
    panel.remove();
    expect(writes).toHaveLength(writeCount);
    expect(savedIds()).toEqual(["session-a", "session-b"]);
    second.resolve(attachResult(second.sessionId));

    const replacement = mountPanel(gateway.client);
    const restoredFirst = await waitForAttach(gateway, 2);
    expect(writes).toHaveLength(writeCount);
    restoredFirst.resolve(attachResult(restoredFirst.sessionId));
    const restoredSecond = await waitForAttach(gateway, 3);
    expect(savedIds()).toEqual(["session-a", "session-b"]);
    restoredSecond.resolve(attachResult(restoredSecond.sessionId));
    await waitForFast(() => expect(replacement.sessions.booting).toBe(false));

    expect(replacement.sessions.tabs.map((tab) => tab.gatewaySessionId)).toEqual([
      "session-a",
      "session-b",
    ]);
    expect(savedIds()).toEqual(["session-a", "session-b"]);
    expect(gateway.requests.some(({ method }) => method === "terminal.open")).toBe(false);
    expect(gateway.requests.some(({ method }) => method === "terminal.close")).toBe(false);
  });

  it.each([
    { closeIndex: 0, closed: "session-a", remaining: "session-b" },
    { closeIndex: 1, closed: "session-b", remaining: "session-a" },
  ])(
    "retires a deliberate close of $closed while the second attach is pending",
    async ({ closeIndex, closed, remaining }) => {
      const { gateway, panel, sessions, second } = await startInterruptedRestore();
      const close =
        panel.renderRoot.querySelectorAll<HTMLButtonElement>(".tabstrip-tab__close")[closeIndex];
      expect(close).toBeDefined();
      close!.click();
      expect(savedIds()).toEqual([remaining]);
      if (closeIndex === 1) {
        expect(gateway.requests.some(({ method }) => method === "terminal.close")).toBe(false);
      }

      second.resolve(attachResult(second.sessionId));
      await waitForFast(() => expect(sessions.booting).toBe(false));
      expect(gateway.requests).toContainEqual({
        method: "terminal.close",
        params: { sessionId: closed },
      });
      expect(sessions.tabs.map((tab) => tab.gatewaySessionId)).toEqual([remaining]);
      expect(savedIds()).toEqual([remaining]);
    },
  );

  it.each(
    (["resolve", "reject"] as const).flatMap((outcome) =>
      (["dock", "page"] as const).flatMap((surface) => [
        { outcome, surface, keepSibling: false },
        { outcome, surface, keepSibling: true },
      ]),
    ),
  )(
    "finishes the cancelled restore on $surface after $outcome (keep sibling: $keepSibling)",
    async ({ outcome, surface, keepSibling }) => {
      const queueCalls = vi.spyOn(TerminalIntentQueue.prototype, "queue");
      const page = surface === "page";
      const storageKey = page ? `${STORAGE_KEY}:page:null` : STORAGE_KEY;
      const sessionIds = keepSibling ? ["session-a", "session-b"] : ["session-a"];
      sessionStorage.setItem(storageKey, JSON.stringify(sessionIds));
      const gateway = createGateway(sessionIds);
      const { panel } = mountPanel(gateway.client, { page });
      const first = await waitForAttach(gateway, 0);
      panel.renderRoot.querySelector<HTMLButtonElement>(".tabstrip-tab__close")!.click();
      await panel.updateComplete;
      expect(panel.terminalPanelOpen).toBe(page || keepSibling);
      expect(JSON.parse(sessionStorage.getItem(storageKey) ?? "[]")).toEqual(
        keepSibling ? ["session-b"] : [],
      );
      if (outcome === "resolve") {
        first.resolve(attachResult(first.sessionId));
      } else {
        first.reject(new Error("closed restore request failed"));
      }
      if (keepSibling) {
        const second = await waitForAttach(gateway, 1);
        second.resolve(attachResult(second.sessionId));
      }
      await Promise.all(queueCalls.mock.results.map((result) => result.value));
      await waitForFast(() =>
        expect(
          panel.terminalPanelOpen
            ? panel.renderRoot.querySelector<HTMLButtonElement>(".tabstrip-new")?.disabled
            : false,
        ).toBe(false),
      );
      expect(panel.terminalPanelOpen).toBe(page || keepSibling);
      expect(gateway.requests.filter((request) => request.method === "terminal.open")).toEqual([]);
      expect(gateway.attaches.map((request) => request.sessionId)).toEqual(sessionIds);
      expect(panel.renderRoot.querySelectorAll(".tabstrip-tab")).toHaveLength(keepSibling ? 1 : 0);
      expect(panel.renderRoot.querySelector(".tp-error")).toBeNull();
      expect(JSON.parse(sessionStorage.getItem(storageKey) ?? "[]")).toEqual(
        keepSibling ? ["session-b"] : [],
      );
      expect(gateway.requests.filter((request) => request.method === "terminal.close")).toEqual(
        outcome === "resolve"
          ? [{ method: "terminal.close", params: { sessionId: "session-a" } }]
          : [],
      );
    },
  );

  it.each(
    (["reconnect", "remount"] as const).flatMap((transition) =>
      (["resolve", "reject"] as const).map((outcome) => ({ transition, outcome })),
    ),
  )(
    "does not replace the cancelled dock restore across $transition before $outcome",
    async ({ transition, outcome }) => {
      const queueCalls = vi.spyOn(TerminalIntentQueue.prototype, "queue");
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(["session-a"]));
      const gateway = createGateway(["session-a"]);
      let current = mountPanel(gateway.client);
      const first = await waitForAttach(gateway, 0);
      current.panel.renderRoot.querySelector<HTMLButtonElement>(".tabstrip-tab__close")!.click();
      await current.panel.updateComplete;
      expect(savedIds()).toEqual([]);
      if (transition === "remount") {
        current.panel.remove();
        current = mountPanel(gateway.client, { open: false });
      } else {
        current.panel.client = null;
        current.panel.available = false;
        await current.panel.updateComplete;
        current.panel.client = gateway.client;
        current.panel.available = true;
      }
      await current.panel.updateComplete;
      if (outcome === "resolve") {
        first.resolve(attachResult(first.sessionId));
      } else {
        first.reject(new Error("cancelled old restore failed"));
      }
      await Promise.all(queueCalls.mock.results.map((result) => result.value));
      await waitForFast(() =>
        expect(
          current.panel.terminalPanelOpen
            ? current.panel.renderRoot.querySelector<HTMLButtonElement>(".tabstrip-new")?.disabled
            : false,
        ).toBe(false),
      );
      expect(current.panel.terminalPanelOpen).toBe(false);
      expect(current.panel.renderRoot.querySelector(".tp-error")).toBeNull();
      expect(gateway.requests.filter(({ method }) => method === "terminal.open")).toEqual([]);
      expect(gateway.requests.filter(({ method }) => method === "terminal.close")).toEqual(
        outcome === "resolve"
          ? [{ method: "terminal.close", params: { sessionId: "session-a" } }]
          : [],
      );
    },
  );

  it("opens a persisted catalog request after its restored tab is cancelled", async () => {
    const catalog = { catalogId: "catalog-a", hostId: "host-a", threadId: "thread-a" };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(["session-a"]));
    sessionStorage.setItem(
      "openclaw.terminal.actions.v1",
      JSON.stringify([{ kind: "catalog", agentId: "agent-a", catalog }]),
    );
    const gateway = createGateway(["session-a"]);
    const { panel } = mountPanel(gateway.client);
    const first = await waitForAttach(gateway, 0);
    panel.renderRoot.querySelector<HTMLButtonElement>(".tabstrip-tab__close")!.click();
    first.resolve(attachResult(first.sessionId));
    await waitForFast(() =>
      expect(gateway.requests.filter(({ method }) => method === "terminal.open")).toHaveLength(1),
    );
    gateway.emit({
      event: "terminal.data",
      payload: { sessionId: "replacement", seq: 5, data: "ready" },
    });
    await waitForFast(() =>
      expect(panel.renderRoot.querySelector<HTMLButtonElement>(".tabstrip-new")?.disabled).toBe(
        false,
      ),
    );
    expect(gateway.requests).toContainEqual({
      method: "terminal.open",
      params: { agentId: "agent-a", catalog, cols: 100, rows: 30 },
    });
    expect(panel.terminalPanelOpen).toBe(true);
    expect(panel.renderRoot.querySelector(".tp-error")).toBeNull();
    expect(savedIds()).toEqual(["replacement"]);
  });

  it.each(["resolve", "reject"] as const)(
    "keeps a queued attach visible after a cancelled restore and follower %s",
    async (outcome) => {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(["session-a"]));
      const gateway = createGateway();
      const { panel } = mountPanel(gateway.client);
      const first = await waitForAttach(gateway, 0);
      window.dispatchEvent(
        new CustomEvent("openclaw:terminal-toggle", {
          detail: { open: true, terminalSessionId: "session-b" },
        }),
      );
      panel.renderRoot.querySelector<HTMLButtonElement>(".tabstrip-tab__close")!.click();
      first.resolve(attachResult(first.sessionId));
      const follower = await waitForAttach(gateway, 1);
      if (outcome === "resolve") {
        follower.resolve(attachResult(follower.sessionId));
      } else {
        follower.reject(new Error("queued attach failed"));
      }
      await waitForFast(() =>
        expect(panel.renderRoot.querySelector<HTMLButtonElement>(".tabstrip-new")?.disabled).toBe(
          false,
        ),
      );
      expect(panel.terminalPanelOpen).toBe(true);
      expect(gateway.attaches.map((request) => request.sessionId)).toEqual([
        "session-a",
        "session-b",
      ]);
      expect(gateway.requests.filter((request) => request.method === "terminal.open")).toEqual([]);
      expect(savedIds()).toEqual(outcome === "resolve" ? ["session-b"] : []);
      if (outcome === "resolve") {
        expect(panel.renderRoot.querySelector(".tp-error")).toBeNull();
      } else {
        expect(panel.renderRoot.querySelector(".tp-error")?.textContent).toContain(
          "queued attach failed",
        );
      }
    },
  );

  it("retires an exit delivered before adoption without resurrecting its id on attach completion", async () => {
    const { gateway, sessions, second } = await startInterruptedRestore();
    const writes = recordSessionWrites(sessions);
    gateway.emit({
      event: "terminal.exit",
      payload: { sessionId: "session-b", exitCode: 0, reason: "exited" },
    });
    second.resolve(attachResult(second.sessionId));
    await waitForFast(() => expect(sessions.booting).toBe(false));

    expect(writes).toContainEqual({
      ids: ["session-a"],
      tabs: [
        { sessionId: "session-a", status: "live" },
        { sessionId: "", status: "exited" },
      ],
    });
    expect(sessions.tabs[1]).toMatchObject({ gatewaySessionId: "session-b", status: "exited" });
    expect(savedIds()).toEqual(["session-a"]);
    expect(gateway.requests).not.toContainEqual({
      method: "terminal.resize",
      params: { sessionId: "session-b", cols: 100, rows: 30 },
    });
  });

  it("removes an adopted session that exits while another restore is pending", async () => {
    const { gateway, sessions, second } = await startInterruptedRestore();
    gateway.emit({
      event: "terminal.exit",
      payload: { sessionId: "session-a", exitCode: 0, reason: "exited" },
    });
    expect(savedIds()).toEqual(["session-b"]);
    second.resolve(attachResult(second.sessionId));
    await waitForFast(() => expect(sessions.booting).toBe(false));
    expect(savedIds()).toEqual(["session-b"]);
  });

  it.each(
    ["same-client reconnect", "replacement client", "replacement host"].flatMap((transition) =>
      ["resolve", "reject"].map((completion) => ({ transition, completion })),
    ),
  )(
    "keeps the restore set across $transition and a stale attach $completion",
    async ({ transition, completion }) => {
      const { gateway, panel, sessions, second } = await startInterruptedRestore();
      const currentGateway = transition === "same-client reconnect" ? gateway : createGateway();
      let current = { panel, sessions };
      const writes = recordSessionWrites(sessions);
      if (transition === "replacement host") {
        panel.remove();
        current = mountPanel(currentGateway.client);
      } else {
        if (transition === "same-client reconnect") {
          panel.client = null;
          panel.available = false;
          await panel.updateComplete;
          await waitForFast(() => expect(sessions.tabs).toHaveLength(0));
        }
        panel.client = currentGateway.client;
        panel.available = true;
        await panel.updateComplete;
      }
      await waitForFast(() => expect(sessions.tabs).toHaveLength(0));
      expect(writes).toHaveLength(0);
      expect(savedIds()).toEqual(["session-a", "session-b"]);

      if (completion === "resolve") {
        second.resolve(attachResult(second.sessionId));
      } else {
        second.reject(new Error("old connection closed"));
      }
      const firstIndex = currentGateway === gateway ? 2 : 0;
      const restoredFirst = await waitForAttach(currentGateway, firstIndex);
      expect(writes).toHaveLength(0);
      restoredFirst.resolve(attachResult(restoredFirst.sessionId));
      const restoredSecond = await waitForAttach(currentGateway, firstIndex + 1);
      expect(savedIds()).toEqual(["session-a", "session-b"]);
      restoredSecond.resolve(attachResult(restoredSecond.sessionId));
      await waitForFast(() => expect(current.sessions.booting).toBe(false));
      expect(savedIds()).toEqual(["session-a", "session-b"]);
      expect(gateway.requests.some(({ method }) => method === "terminal.close")).toBe(false);
    },
  );

  it("prunes a completed transient failure but retains a later unresolved session", async () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(["session-a", "session-b", "session-c"]));
    const gateway = createGateway(["session-a", "session-b", "session-c"]);
    const { sessions } = mountPanel(gateway.client);
    const first = await waitForAttach(gateway, 0);
    first.resolve(attachResult(first.sessionId));
    const second = await waitForAttach(gateway, 1);
    second.reject(new Error("gateway temporarily unavailable"));
    const third = await waitForAttach(gateway, 2);
    expect(gateway.list).toHaveBeenCalledTimes(2);
    expect(savedIds()).toEqual(["session-a", "session-c"]);
    third.resolve(attachResult(third.sessionId));
    await waitForFast(() => expect(sessions.booting).toBe(false));
    expect(savedIds()).toEqual(["session-a", "session-c"]);
    expect(sessions.tabs.every((tab) => tab.status === "live")).toBe(true);
  });

  it("prunes a failed list before opening the existing fresh-session fallback", async () => {
    const gateway = createGateway();
    gateway.list.mockRejectedValueOnce(new Error("gateway temporarily unavailable"));
    const { sessions } = mountPanel(gateway.client);
    await waitForFast(() => expect(savedIds()).toEqual(["replacement"]));
    expect(gateway.attaches).toHaveLength(0);
    expect(sessions.tabs.map((tab) => tab.gatewaySessionId)).toEqual(["replacement"]);
    expect(sessions.booting).toBe(false);
  });

  it("restores duplicate stored ids once and persists their original order", async () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(["session-b", "session-a", "session-b"]));
    const gateway = createGateway();
    const { sessions } = mountPanel(gateway.client);
    const first = await waitForAttach(gateway, 0);
    expect(first.sessionId).toBe("session-b");
    first.resolve(attachResult(first.sessionId));
    const second = await waitForAttach(gateway, 1);
    expect(second.sessionId).toBe("session-a");
    expect(savedIds()).toEqual(["session-b", "session-a"]);
    second.resolve(attachResult(second.sessionId));
    await waitForFast(() => expect(sessions.booting).toBe(false));
    expect(gateway.attaches).toHaveLength(2);
    expect(savedIds()).toEqual(["session-b", "session-a"]);
  });
});
