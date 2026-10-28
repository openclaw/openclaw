import { createMemo, For } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS,
} from "../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { projectOwner } from "../lib/reactive/projection.ts";
import {
  createGatewayHarness as createPullRequestGateway,
  createHello,
} from "../lib/session-pull-requests.test-support.ts";
import { sessionPullRequestsForGateway } from "../lib/session-pull-requests.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { createTestSessionCapability } from "../lib/sessions/session-capability.test-support.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import { createSessionPullRequestIndicators } from "./app-sidebar-session-pr-indicators.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

type IndicatorOptions = Parameters<typeof createSessionPullRequestIndicators>[0];
const LIFECYCLE_HOST_TAG = "test-session-pr-indicators";

class LifecycleTestHost extends HTMLElement {
  readRows: IndicatorOptions["getRows"] = () => [];
  gateway!: ApplicationGateway;
  getSessions: IndicatorOptions["getSessions"] = () => undefined;
  rowsSource: SessionCapability | undefined;
  selectedAgentId = "main";
  presented = true;
  private readonly listeners = new Set<() => void>();
  indicators!: ReturnType<typeof createSessionPullRequestIndicators>;
  private view?: ReturnType<typeof mountSolid>;

  setInputs(
    values: Partial<
      Pick<
        LifecycleTestHost,
        "gateway" | "getSessions" | "rowsSource" | "selectedAgentId" | "presented"
      >
    >,
  ) {
    Object.assign(this, values);
    this.publishInputs();
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publishInputs() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  connectedCallback(): void {
    this.view = mountSolid(() => createIndicatorView(this), { container: this });
  }
  disconnectedCallback(): void {
    this.view?.unmount();
    this.view = undefined;
  }
  get updateComplete(): Promise<boolean> {
    return Promise.resolve().then(() => {
      flush();
      return true;
    });
  }
}

function createIndicatorView(host: LifecycleTestHost) {
  const inputs = projectOwner(host, (owner) => owner);
  const sessionRows = createMemo(() => {
    const sessions = inputs.read().rowsSource;
    return sessions ? projectOwner(sessions, () => host.readRows()) : null;
  });
  const rows = createMemo(() => {
    const current = inputs.read();
    return sessionRows()?.read() ?? current.readRows();
  });
  const indicators = createSessionPullRequestIndicators({
    getConnected: () => host.isConnected && inputs.read().gateway.snapshot.phase === "connected",
    getPresented: () => inputs.read().presented,
    getRows: rows,
    getSelectedAgentId: () => inputs.read().selectedAgentId,
    getGateway: () => inputs.read().gateway,
    getSessions: () => inputs.read().getSessions(),
  });
  host.indicators = indicators;
  return (
    <For each={rows()}>
      {(row) => (
        <span data-session-key={row.key}>
          {indicators.summary(row.key, row.worktreeId ?? "", row.pullRequest)?.numbers.join(",")}
        </span>
      )}
    </For>
  );
}

if (!customElements.get(LIFECYCLE_HOST_TAG)) {
  customElements.define(LIFECYCLE_HOST_TAG, LifecycleTestHost);
}

function mountLifecycleHost(
  gateway: ApplicationGateway,
  rows: readonly SidebarRecentSession[] | IndicatorOptions["getRows"],
  sessions?: SessionCapability,
): LifecycleTestHost {
  const host = new LifecycleTestHost();
  host.setInputs({ gateway, getSessions: () => sessions });
  host.readRows = typeof rows === "function" ? rows : () => rows;
  document.body.append(host);
  return host;
}

function sessionRow(key: string, worktreeId: string, fields: Partial<SidebarRecentSession> = {}) {
  return { key, isChild: false, worktreeId, ...fields } as SidebarRecentSession;
}

async function settle(host: LifecycleTestHost) {
  await host.updateComplete;
  await vi.advanceTimersByTimeAsync(0);
}

function createGatewayHarness(scopes = ["operator.read"]) {
  const harness = createPullRequestGateway();
  harness.gateway.snapshot.hello = createHello(scopes);
  return {
    ...harness,
    publish(key: string, fields: Record<string, unknown> = {}) {
      harness.emit({
        sessions: { [key]: { pullRequests: [], rateLimited: false, status: "ready", ...fields } },
      });
    },
  };
}

function mountRow(row = sessionRow("agent:main:demo", "wt-demo"), scopes?: string[]) {
  const harness = createGatewayHarness(scopes);
  return { harness, row, host: mountLifecycleHost(harness.gateway, [row]) };
}

function expectSubscription(
  harness: ReturnType<typeof createGatewayHarness>,
  passiveSessionKeys: string[],
  sessionKeys: string[] = [],
) {
  expect(harness.request).toHaveBeenLastCalledWith(
    SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
    { sessionKeys, passiveSessionKeys },
    { timeoutMs: 30_000, signal: expect.any(AbortSignal) },
  );
}

function summary(
  host: LifecycleTestHost,
  row: SidebarRecentSession,
  initial?: SidebarRecentSession["pullRequest"],
) {
  return host.indicators.summary(row.key, row.worktreeId ?? "", initial);
}

function setScopes(host: LifecycleTestHost, scopes: string[]) {
  host.gateway.snapshot.hello = {
    ...host.gateway.snapshot.hello!,
    auth: { role: "operator", scopes },
  };
  host.setInputs({ gateway: host.gateway });
  return host.updateComplete;
}

afterEach(() => {
  document.querySelectorAll(LIFECYCLE_HOST_TAG).forEach((host) => host.remove());
  vi.useRealTimers();
});

it("keeps session-only viewers passive and shows only their own conversation's confirmed badge", async () => {
  vi.useFakeTimers();
  const other = sessionRow("agent:main:other", "wt-other", {
    pullRequest: { numbers: [9], state: "open" },
  });
  const { harness, row, host } = mountRow(undefined, [
    "operator.sessions.read",
    "operator.sessions.write",
  ]);
  host.readRows = () => [row, other];
  await settle(host);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(harness.request).not.toHaveBeenCalled();
  expect(summary(host, row)).toBeUndefined();
  const initial = { numbers: [42], state: "open" as const };
  expect(host.indicators.summary(row.key, "", initial)).toEqual(initial);
  expect(summary(host, row, initial)).toBeUndefined();

  const store = sessionPullRequestsForGateway(harness.gateway);
  const conversation = {};
  store.watch(conversation, [row.key], { foreground: true });
  onTestFinished(() => store.unwatch(conversation));
  await vi.advanceTimersByTimeAsync(0);
  expect(harness.request).toHaveBeenLastCalledWith(
    SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
    { sessionKeys: [row.key] },
    { timeoutMs: 30_000, signal: expect.any(AbortSignal) },
  );
  harness.publish(row.key, { pullRequests: [{ number: 7, state: "open" }] });
  await host.updateComplete;
  expect(summary(host, row)).toEqual({ numbers: [7], state: "open" });
  expect(host.indicators.count(row.key)).toBe(1);
  // Another checkout row keeps its catalog summary hidden: no own read confirmed it.
  expect(summary(host, other, other.pullRequest)).toBeUndefined();

  harness.publish(row.key, { status: "unavailable", discardPrevious: true });
  await host.updateComplete;
  expect(summary(host, row)).toBeUndefined();
  expect(host.indicators.count(row.key)).toBe(0);
});
it("keeps empty rows idle across sidebar updates", async () => {
  vi.useFakeTimers();
  const harness = createGatewayHarness();
  const getRows = vi.fn(() => []);
  const host = mountLifecycleHost(harness.gateway, getRows);
  await settle(host);

  host.setInputs({ selectedAgentId: "work" });
  host.setInputs({ selectedAgentId: "main" });
  expect(await host.updateComplete).toBe(true);
  await vi.advanceTimersByTimeAsync(0);

  expect(host.textContent).toBe("");
  expect(harness.request).not.toHaveBeenCalled();
});

it("observes visible rows and keeps the pushed merged summary through backoff", async () => {
  vi.useFakeTimers();
  const { harness, row, host } = mountRow();
  await settle(host);
  expectSubscription(harness, [row.key]);
  const store = sessionPullRequestsForGateway(harness.gateway);
  const activeOwner = {};
  store.watch(activeOwner, [row.key], { foreground: true });
  onTestFinished(() => store.unwatch(activeOwner));
  await vi.advanceTimersByTimeAsync(0);
  expect(harness.request).toHaveBeenLastCalledWith(
    SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
    { sessionKeys: [row.key] },
    { timeoutMs: 30_000, signal: expect.any(AbortSignal) },
  );

  const state = "merged";
  const expected = { numbers: [1, 2], state };
  harness.publish(row.key, {
    pullRequests: [
      { number: 2, state },
      { number: 1, url: "https://example.test/pr/1", state },
    ],
    rateLimited: true,
    status: "rate-limited",
  });
  await host.updateComplete;
  expect(summary(host, row)).toEqual(expected);

  harness.publish(row.key, { rateLimited: true, status: "rate-limited" });
  await host.updateComplete;
  expect(summary(host, row)).toEqual(expected);

  harness.publish(row.key, { status: "unavailable", discardPrevious: true });
  await host.updateComplete;
  expect(store.get(row.key)?.pullRequests).toEqual([]);
  expect(host.textContent).toBe("");
  expect(host.indicators.count(row.key)).toBe(0);
  expect(summary(host, row, { numbers: [99], state })).toBeUndefined();

  harness.publish(row.key);
  await host.updateComplete;
  expect(summary(host, row, { numbers: [99], state })).toBeUndefined();
  host.remove();
});

it("counts cold task receipts without a worktree or an invented state", async () => {
  vi.useFakeTimers();
  const { harness, row, host } = mountRow({
    key: "agent:main:task",
    isChild: false,
  } as SidebarRecentSession);
  await settle(host);
  const tasks = [41, 42, 43].map((number) => ({
    owner: "example",
    repo: "project",
    number,
    url: "https://github.com/example/project/pull/" + number,
    branch: "fix/child",
    sourceSessionKey: "agent:main:child",
    sourceAgentId: "main",
  }));
  harness.publish(row.key, { taskPullRequests: tasks, taskPullRequestCount: 3 });
  await host.updateComplete;
  expect(host.indicators.count(row.key)).toBe(3);
  expect(host.indicators.summary(row.key, "")).toBeUndefined();
  harness.publish(row.key, { taskPullRequests: [], taskPullRequestCount: 0 });
  await host.updateComplete;
  expect(host.indicators.count(row.key)).toBe(0);
});

it("preserves catalog branch facts only while receipt-only hydration leaves the branch unread", async () => {
  vi.useFakeTimers();
  const { harness, row, host } = mountRow(sessionRow("agent:main:task", "wt"));
  const initial = { numbers: [40], state: "open" as const };
  await settle(host);
  for (const [index, branchRead] of [false, undefined, false].entries()) {
    harness.publish(row.key, {
      ...(branchRead === false ? { branchRead } : {}),
      taskPullRequests: [],
      taskPullRequestCount: 0,
    });
    await host.updateComplete;
    expect(host.indicators.summary(row.key, "wt", initial)).toEqual(
      index === 0 ? initial : undefined,
    );
    expect(host.indicators.count(row.key)).toBe(index === 0 ? undefined : 0);
  }
});

it("clears alias indicators when the selected agent changes", async () => {
  vi.useFakeTimers();
  const { harness, row, host } = mountRow(sessionRow("global", "wt-global"));
  await settle(host);
  harness.publish("agent:main:global", {
    pullRequests: [{ number: 1, url: "https://example.test/pr/1", state: "open" }],
  });
  await host.updateComplete;
  expect(summary(host, row)).toEqual({ numbers: [1], state: "open" });

  host.setInputs({ selectedAgentId: "work" });
  await settle(host);

  await host.updateComplete;
  expect(summary(host, row)).toBeUndefined();
});

it("clears a structural session's indicator while replacement data is pending", async () => {
  vi.useFakeTimers();
  const harness = createGatewayHarness();
  const row = sessionRow("agent:main:demo", "wt-demo");
  const epoch = {};
  const setPullRequestSummary = vi.fn();
  const host = mountLifecycleHost(harness.gateway, [row], {
    subscribe: () => () => {},
    capturePullRequestEpoch: vi.fn(() => epoch),
    setPullRequestSummary,
  } as unknown as SessionCapability);
  await settle(host);
  harness.publish(row.key, { pullRequests: [{ number: 1, state: "open" }] });
  await host.updateComplete;
  expect(summary(host, row)).toEqual({ numbers: [1], state: "open" });

  harness.emit({ sessionKey: row.key, agentId: "main", reason: "rewind" }, "sessions.changed");

  await host.updateComplete;
  expect(summary(host, row)).toBeUndefined();
  expect(setPullRequestSummary).toHaveBeenCalledExactlyOnceWith(row.key, undefined, epoch);
});

it.each(["agent", "client", "permissions", "sessions"] as const)(
  "retires %s scope while summaries are parked",
  async (change) => {
    const harness = createGatewayHarness();
    const sessions = createTestSessionCapability(harness.gateway);
    const row = sessionRow("global", "wt-global");
    const host = mountLifecycleHost(harness.gateway, [row], sessions);
    await host.updateComplete;
    harness.publish("agent:main:global", { pullRequests: [{ number: 7, state: "open" }] });
    await host.updateComplete;
    expect(host.textContent).toBe("7");
    host.setInputs({ presented: false });
    await host.updateComplete;

    const currentSessions =
      change === "sessions" ? createTestSessionCapability(harness.gateway) : sessions;
    const clearSummary = vi.spyOn(currentSessions, "setPullRequestSummary");
    if (change === "sessions") {
      host.setInputs({ getSessions: () => currentSessions });
    }
    if (change === "agent") {
      host.setInputs({ selectedAgentId: "work" });
    }
    if (change === "client") {
      harness.gateway.snapshot.client = {
        request: harness.request,
      } as unknown as GatewayBrowserClient;
    }
    if (change === "permissions") {
      harness.gateway.snapshot.hello = {
        ...harness.gateway.snapshot.hello!,
        auth: { role: "operator", scopes: ["operator.sessions.read"] },
      };
    }
    host.setInputs({ gateway: harness.gateway });
    await host.updateComplete;
    const store = sessionPullRequestsForGateway(harness.gateway);
    expect(store.get("agent:main:global")).toBeUndefined();
    harness.emit({ sessionKey: "global", agentId: "main", reason: "rewind" }, "sessions.changed");
    await host.updateComplete;
    expect(clearSummary).not.toHaveBeenCalled();
    expect(host.textContent).toBe("7");
    for (const [, params] of harness.request.mock.calls) {
      expect(params).toMatchObject({ sessionKeys: [] });
    }

    host.setInputs({ presented: true });
    await host.updateComplete;
    expect(host.textContent).toBe("");
  },
);
it("hides the row's saved PR summary after a same-client read-scope revocation", async () => {
  const row = sessionRow("agent:main:demo", "wt-demo", {
    pullRequest: { numbers: [42], state: "open" },
  });
  const { host } = mountRow(row);
  await host.updateComplete;
  expect(host.textContent).toContain("42");

  await setScopes(host, ["operator.sessions.read", "operator.sessions.write"]);
  expect(host.textContent).not.toContain("42");
  expect(host.indicators.summary(row.key, row.worktreeId!, row.pullRequest)).toBeUndefined();

  await setScopes(host, ["operator.read"]);
  expect(host.textContent).toContain("42");
});

it("retains sidebar snapshots while only the viewed checkout drives subscriptions", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const harness = createGatewayHarness();
  const rows = Array.from({ length: 40 }, (_, index) =>
    sessionRow(`agent:main:demo-${index}`, `wt-demo-${index}`),
  );
  const host = mountLifecycleHost(harness.gateway, rows);

  await settle(host);

  expectSubscription(harness, rows.map((row) => row.key).toSorted());

  const viewer = {};
  const store = sessionPullRequestsForGateway(harness.gateway);
  const key = rows[0]!.key;
  store.watch(viewer, [key], { foreground: true });
  await vi.advanceTimersByTimeAsync(0);
  expectSubscription(
    harness,
    rows
      .slice(1)
      .map((row) => row.key)
      .toSorted(),
    [key],
  );
  harness.publish(key, { pullRequests: [{ number: 7, state: "open" }] });
  store.unwatch(viewer);
  await vi.advanceTimersByTimeAsync(0);
  await host.updateComplete;
  expectSubscription(harness, rows.map((row) => row.key).toSorted());
  expect(host.textContent?.trim()).toBe("7");

  harness.request.mockClear();
  harness.emit({ sessionKey: key, agentId: "main", reason: "rewind" }, "sessions.changed");
  await vi.advanceTimersByTimeAsync(5_000);
  await host.updateComplete;
  expect(host.textContent?.trim()).toBe("");
  expect(harness.request).not.toHaveBeenCalled();
});

it("clears a rendered fallback after the visible snapshot leaves the bounded watch union", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const harness = createGatewayHarness();
  const key = "agent:main:demo";
  const sessions = createTestSessionCapability(harness.gateway);
  sessions.setPullRequestSummary(key, { numbers: [7], state: "open" });
  const captureEpoch = vi.spyOn(sessions, "capturePullRequestEpoch");
  const setPullRequestSummary = vi.spyOn(sessions, "setPullRequestSummary");
  const host = mountLifecycleHost(
    harness.gateway,
    () => [sessionRow(key, "wt-demo", { pullRequest: sessions.pullRequestSummary(key) })],
    sessions,
  );
  host.setInputs({ rowsSource: sessions });
  await settle(host);
  harness.publish(key, { pullRequests: [{ number: 7, state: "open" }] });
  await host.updateComplete;
  expect(host.textContent?.trim()).toBe("7");

  const store = sessionPullRequestsForGateway(harness.gateway);
  const foregroundOwner = {};
  try {
    store.watch(
      foregroundOwner,
      Array.from(
        { length: CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS },
        (_, index) => `agent:main:foreground-${index}`,
      ),
      { foreground: true },
    );
    expect(store.get(key)).toBeUndefined();
    await settle(host);
    await host.updateComplete;

    expect(captureEpoch).toHaveBeenCalledExactlyOnceWith(key);
    expect(setPullRequestSummary).toHaveBeenCalledExactlyOnceWith(
      key,
      undefined,
      captureEpoch.mock.results[0]?.value,
    );
    expect(sessions.pullRequestSummary(key)).toBeUndefined();
    expect(host.textContent?.trim()).toBe("");
  } finally {
    store.unwatch(foregroundOwner);
  }
});

it("keeps sidebar watches passive across disconnect and reconnect", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const { harness, row, host } = mountRow();
  await settle(host);
  const expectWatch = () =>
    expect(harness.request.mock.lastCall?.[1]).toEqual(
      host.isConnected ? { sessionKeys: [], passiveSessionKeys: [row.key] } : { sessionKeys: [] },
    );
  expectWatch();

  host.remove();
  await settle(host);

  expectWatch();

  document.body.append(host);
  await settle(host);

  expectWatch();
});

it("retains rendered PR facts on link loss without retaining subscription authority", async () => {
  vi.useFakeTimers();
  const { harness, row, host } = mountRow();
  await settle(host);
  harness.publish(row.key, { pullRequests: [{ number: 42, state: "open" }] });
  await host.updateComplete;
  expect(summary(host, row)).toEqual({ numbers: [42], state: "open" });
  const requests = harness.request.mock.calls.length;
  harness.setSnapshot({ ...harness.gateway.snapshot, phase: "reconnecting", selfUser: undefined });
  host.setInputs({ gateway: harness.gateway });
  await settle(host);
  expect(summary(host, row)).toEqual({ numbers: [42], state: "open" });
  expect(host.indicators.count(row.key)).toBe(1);
  expect(harness.request).toHaveBeenCalledTimes(requests);
  Object.assign(harness.gateway, { connectionRevision: 1 });
  host.setInputs({ gateway: harness.gateway });
  await settle(host);
  expect(summary(host, row)).toBeUndefined();
  expect(host.indicators.count(row.key)).toBeUndefined();
  expect(harness.request).toHaveBeenCalledTimes(requests);
});
