import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { ApplicationContext } from "../../../app/context.ts";
import { t } from "../../../i18n/index.ts";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import {
  createSubscriptionHydrationHarness,
  sessionsResult,
} from "../../sessions/session-capability.test-support.ts";
import "./session-progress.tsx";

function createContext(
  progressRead: () => Promise<unknown> = async () => ({ card: null }),
  describe: () => Promise<{ session: GatewaySessionRow | null }> = async () => ({ session: null }),
) {
  const listRead = vi.fn((_params?: Record<string, unknown>) => sessionsResult([], 1));
  const { gateway, sessions, selection, connect, disconnect, emitEvent } =
    createSubscriptionHydrationHarness(async (method, params) => {
      if (method === "sessions.list") {
        return listRead(params);
      }
      if (method === "sessions.describe") {
        return describe();
      }
      if (method === "progressCard.get") {
        return progressRead();
      }
      throw new Error(`Unexpected request: ${method}`);
    });
  connect();
  let active = 0;
  const observeRow = sessions.observeRow.bind(sessions);
  const subscribe = vi.spyOn(sessions, "observeRow").mockImplementation((...args) => {
    const observation = observeRow(...args);
    const release = observation.dispose;
    active += 1;
    observation.dispose = () => {
      release();
      active -= 1;
    };
    return observation;
  });
  onTestFinished(() => {
    sessions.dispose();
    selection.dispose();
  });
  return {
    context: { gateway, sessions, agentSelection: selection } as unknown as ApplicationContext,
    selection,
    connect,
    disconnect,
    emitEvent,
    listRead,
    targets: () => subscribe.mock.calls.map(([target]) => target),
    subscriptions: () => [active, subscribe.mock.calls.length],
  };
}

function mount(
  context: ApplicationContext,
  sessionKey = "agent:main:progress-widget",
  active = true,
) {
  const provider = createApplicationContextProvider(context);
  const element = document.createElement("openclaw-session-progress-widget");
  element.session = { sessionKey };
  element.active = active;
  provider.append(element);
  document.body.append(provider);
  return { provider, element };
}

async function ready(element: HTMLElementTagNameMap["openclaw-session-progress-widget"]) {
  await element.updateComplete;
  await vi.waitFor(() =>
    expect(element.textContent).toContain(t("sessionProgressCard.widgetEmpty")),
  );
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("shows admitted loading, retries a failed read, and retains accepted progress on refresh failure", async () => {
  const requests = Array.from({ length: 3 }, () => createDeferred<{ card: typeof card }>());
  const card = {
    sessionKey: "agent:main:progress-widget",
    revision: 1,
    updatedAt: 1,
    markdown: "Accepted progress",
  };
  const read = vi.fn();
  for (const request of requests) {
    read.mockReturnValueOnce(request.promise);
  }
  const owner = createContext(read);
  const { element } = mount(owner.context);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  await vi.waitFor(() =>
    expect(element.textContent).toContain(t("sessionProgressCard.widgetLoading")),
  );

  requests[0]!.reject(new Error("Unavailable"));
  await vi.waitFor(() => expect(element.querySelector("[role=alert]")).not.toBeNull());
  expect(element.textContent).not.toContain(t("sessionProgressCard.widgetLoading"));
  element.querySelector<HTMLButtonElement>("button")!.click();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  requests[1]!.resolve({ card });
  await vi.waitFor(() => expect(element.textContent).toContain("Accepted progress"));
  expect(element.querySelector("[role=alert]")).toBeNull();

  owner.emitEvent({
    type: "event",
    event: "progressCard.changed",
    payload: { sessionKey: card.sessionKey, revision: 2 },
  });
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  expect(element.textContent).toContain("Accepted progress");
  expect(element.textContent).not.toContain(t("sessionProgressCard.widgetLoading"));
  requests[2]!.reject(new Error("Refresh unavailable"));
  await vi.waitFor(() => expect(element.querySelector("[role=alert]")).not.toBeNull());
  expect(element.textContent).toContain("Accepted progress");
});

it("does not reacquire a row observation when a queued property update runs after removal", async () => {
  const describe = vi.fn(async () => ({ session: null }));
  const owner = createContext(undefined, describe);
  const { provider, element } = mount(owner.context, undefined, false);
  await element.updateComplete;
  expect(owner.subscriptions()).toEqual([0, 0]);
  expect(describe).not.toHaveBeenCalled();
  element.active = true;

  for (let connections = 1; connections <= 2; connections += 1) {
    await ready(element);
    expect(owner.subscriptions()).toEqual([1, connections]);

    element.session = { sessionKey: `agent:main:queued-${connections}` };
    const update = element.updateComplete;
    element.remove();
    await update;
    expect(element.isConnected).toBe(false);
    expect(owner.subscriptions()).toEqual([0, connections]);

    if (connections === 1) {
      provider.append(element);
    }
  }
});

it("moves the listener with context and activity without duplicating it on selection changes", async () => {
  const first = createContext();
  const second = createContext();
  const { provider, element } = mount(first.context);
  await ready(element);
  const subscriptions = () => [...first.subscriptions(), ...second.subscriptions()];
  expect(subscriptions()).toEqual([1, 1, 0, 0]);
  const selectBoth = () => [first.selection.set("main"), second.selection.set("writer")];
  const transitions: [() => unknown, number, number, number, number][] = [
    [() => first.selection.set("writer"), 1, 1, 0, 0],
    [() => provider.setContext(second.context), 0, 1, 1, 1],
    [selectBoth, 0, 1, 1, 1],
    [() => Object.assign(element, { active: false }), 0, 1, 0, 1],
    [() => Object.assign(element, { active: true }), 0, 1, 1, 2],
    [() => element.remove(), 0, 1, 0, 2],
  ];
  for (const [act, ...expected] of transitions) {
    act();
    await element.updateComplete;
    expect(subscriptions()).toEqual(expected);
  }
});

it("uses the exact target's live status even when it is outside the roster", async () => {
  let row: GatewaySessionRow = {
    key: "agent:main:progress-widget",
    agentId: "main",
    sessionId: "progress-widget",
    kind: "direct",
    status: "running",
    startedAt: 100,
    updatedAt: 101,
    hasActiveRun: true,
  };
  let unavailable = false;
  const owner = createContext(
    async () => ({
      card: {
        sessionKey: row.key,
        revision: 1,
        updatedAt: 101,
        steps: [{ step: "Collect findings", status: "in_progress" }],
      },
    }),
    async () => {
      if (unavailable) {
        throw new Error("Status unavailable");
      }
      return { session: row };
    },
  );
  const { element } = mount(owner.context);
  await vi.waitFor(() =>
    expect(element.querySelector(".session-progress-card__step")?.getAttribute("aria-label")).toBe(
      "Collect findings, in progress",
    ),
  );
  row = {
    ...row,
    status: "done",
    hasActiveRun: false,
    hasActiveSubagentRun: true,
    endedAt: 110,
    updatedAt: 110,
  };
  owner.emitEvent({
    type: "event",
    event: "sessions.changed",
    payload: { reason: "update", agentId: "main", session: row, ts: 110 },
  });
  const runtime = () => element.querySelector(".session-progress-card__runtime")?.textContent;
  await vi.waitFor(() => expect(runtime()).toContain(t("sessionProgressCard.runtime.delegated")));
  expect(element.querySelector(".session-progress-card__step")?.getAttribute("aria-label")).toBe(
    "Collect findings, in progress",
  );

  owner.disconnect();
  await vi.waitFor(() => expect(runtime()).toContain(t("sessionProgressCard.runtime.offline")));
  expect(owner.subscriptions()[0]).toBe(0);
  unavailable = true;
  owner.connect();
  const retry = () =>
    element.querySelector<HTMLButtonElement>('[data-test-id="session-progress-runtime-retry"]');
  await vi.waitFor(() => expect(retry()).not.toBeNull());
  expect(runtime()).toContain(t("sessionProgressCard.runtime.unknown"));
  expect(element.querySelector(".session-run-spinner")).toBeNull();
  unavailable = false;
  row = { ...row, hasActiveSubagentRun: false };
  retry()!.click();
  await vi.waitFor(() => expect(runtime()).toContain(t("sessionProgressCard.runtime.idle")));
  expect(retry()).toBeNull();
});

it("follows a replacement session generation at the same dashboard target", async () => {
  let row: GatewaySessionRow = {
    key: "agent:main:progress-widget",
    agentId: "main",
    sessionId: "original-progress-session",
    kind: "direct",
    status: "running",
    startedAt: 100,
    updatedAt: 101,
    snapshotAt: 101,
    hasActiveRun: true,
  };
  const card = {
    sessionKey: row.key,
    revision: 1,
    updatedAt: 101,
    steps: [{ step: "Collect findings", status: "in_progress" as const }],
  };
  const owner = createContext(
    async () => ({ card }),
    async () => ({ session: row }),
  );
  const { element } = mount(owner.context);
  const runtime = () => element.querySelector(".session-progress-card__runtime")?.textContent;
  await vi.waitFor(() => expect(element.querySelector(".session-run-spinner")).not.toBeNull());

  row = {
    ...row,
    sessionId: "replacement-progress-session",
    status: "done",
    hasActiveRun: false,
    startedAt: 200,
    endedAt: 210,
    updatedAt: 210,
    snapshotAt: 210,
  };
  owner.emitEvent({
    type: "event",
    event: "sessions.changed",
    payload: { reason: "create", agentId: "main", session: row, ancestorSessions: [], ts: 210 },
  });
  await vi.waitFor(() => expect(runtime()).toContain(t("sessionProgressCard.runtime.idle")));
  expect(element.querySelector(".session-run-spinner")).toBeNull();
  expect(owner.subscriptions()).toEqual([1, 2]);

  row = {
    ...row,
    status: "running",
    hasActiveRun: true,
    activeRunIds: ["replacement-run"],
    lastRunId: "replacement-run",
    startedAt: 220,
    endedAt: undefined,
    updatedAt: 220,
    snapshotAt: 220,
  };
  owner.emitEvent({
    type: "event",
    event: "sessions.changed",
    payload: {
      reason: "run-capacity",
      agentId: "main",
      session: row,
      ancestorSessions: [],
      ts: 220,
    },
  });
  await vi.waitFor(() => expect(runtime()).toContain(t("sessionProgressCard.runtime.working")));
  // The retained plan predates this run, so only the runtime line becomes active.
  expect(element.querySelector(".session-run-spinner")).toBeNull();
  expect(owner.subscriptions()).toEqual([1, 2]);
  element.remove();
  await element.updateComplete;
  expect(owner.subscriptions()[0]).toBe(0);
});

it("keeps target observations separate across agents and applications without loading dashboard rosters", async () => {
  const first = createContext();
  const second = createContext();
  const left = mount(first.context, "agent:main:left");
  const right = mount(first.context, "agent:main:right");
  right.element.session = { sessionKey: "right", agentId: " main " };
  const writer = mount(first.context, "agent:writer:progress");
  const otherApplication = mount(second.context, "agent:main:other");
  for (const { element } of [left, right, writer, otherApplication]) {
    await ready(element);
  }
  expect(first.targets()).toEqual([
    { key: "agent:main:left", agentId: "main" },
    { key: "agent:main:right", agentId: "main" },
    { key: "agent:writer:progress", agentId: "writer" },
  ]);
  expect(second.targets()).toEqual([{ key: "agent:main:other", agentId: "main" }]);
  expect(first.subscriptions()).toEqual([3, 3]);
  expect(second.subscriptions()).toEqual([1, 1]);

  left.element.active = false;
  await left.element.updateComplete;
  expect(first.subscriptions()).toEqual([2, 3]);
  right.element.active = false;
  await right.element.updateComplete;
  expect(first.subscriptions()).toEqual([1, 3]);

  left.element.active = true;
  await left.element.updateComplete;
  expect(first.subscriptions()).toEqual([2, 4]);
  left.element.remove();
  writer.element.remove();
  await Promise.all([left.element.updateComplete, writer.element.updateComplete]);
  expect(first.subscriptions()).toEqual([0, 4]);
  expect(second.subscriptions()).toEqual([1, 1]);
  for (const owner of [first, second]) {
    expect(owner.listRead.mock.calls.some(([params]) => params?.source === "dashboard")).toBe(
      false,
    );
  }
});
