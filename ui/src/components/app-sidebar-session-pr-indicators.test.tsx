import { createMemo, createSignal, For } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT,
  CONTROL_UI_SESSION_PULL_REQUESTS_MAX_KEYS,
} from "../../../src/gateway/control-ui-contract.js";
import type { GatewayBrowserClient, GatewayEventListener } from "../api/gateway.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import {
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  sessionPullRequestsForGateway,
} from "../lib/session-pull-requests.ts";
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
  selectedAgentId = "main";
  presented = true;
  indicators!: ReturnType<typeof createSessionPullRequestIndicators>;
  invalidate?: () => void;
  private view?: ReturnType<typeof mountSolid>;

  connectedCallback(): void {
    this.view = mountSolid(() => createIndicatorView(this), { container: this });
  }
  disconnectedCallback(): void {
    this.view?.unmount();
    this.view = undefined;
    this.invalidate = undefined;
  }
  requestUpdate(): void {
    this.invalidate?.();
  }
  get updateComplete(): Promise<boolean> {
    return Promise.resolve().then(() => {
      flush();
      return true;
    });
  }
}

function createIndicatorView(host: LifecycleTestHost) {
  const [revision, invalidate] = createSignal(0);
  host.invalidate = () => invalidate((value) => value + 1);
  const rows = createMemo(() => {
    revision();
    return host.readRows();
  });
  const indicators = createSessionPullRequestIndicators({
    getConnected: () => host.isConnected,
    getPresented: () => {
      revision();
      return host.presented;
    },
    getRows: rows,
    getSelectedAgentId: () => {
      revision();
      return host.selectedAgentId;
    },
    getGateway: () => {
      revision();
      return host.gateway;
    },
    getSessions: () => host.getSessions(),
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
  readRows: IndicatorOptions["getRows"],
  getSessions: IndicatorOptions["getSessions"] = () => undefined,
): LifecycleTestHost {
  const host = new LifecycleTestHost();
  host.gateway = gateway;
  host.readRows = readRows;
  host.getSessions = getSessions;
  document.body.append(host);
  return host;
}

function createGatewayHarness(scopes = ["operator.read"]) {
  const request = vi.fn().mockResolvedValue({ subscribed: true });
  const eventListeners = new Set<GatewayEventListener>();
  const client = { request } as unknown as GatewayBrowserClient;
  const gateway = {
    snapshot: {
      client,
      phase: "connected",
      offlineStable: false,
      hello: {
        auth: { role: "operator", scopes },
        features: { methods: [SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD] },
      },
      canvasPluginSurfaceUrl: null,
      assistantAgentId: "main",
      sessionKey: "agent:main:main",
      lastError: null,
      lastErrorCode: null,
    },
    connection: { gatewayUrl: "ws://example.test", token: "", bootstrapToken: "", password: "" },
    eventLog: [],
    subscribe: () => () => {},
    subscribeEvents(listener: GatewayEventListener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    subscribeEventLog: () => () => {},
    connect: vi.fn(),
    setSessionKey: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as ApplicationGateway;
  return {
    gateway,
    request,
    emit(payload: unknown, event = CONTROL_UI_SESSION_PULL_REQUESTS_CHANGED_EVENT) {
      for (const listener of eventListeners) {
        listener({
          type: "event",
          event,
          payload,
          seq: 1,
        });
      }
    },
  };
}

afterEach(() => {
  document.querySelectorAll(LIFECYCLE_HOST_TAG).forEach((host) => host.remove());
  vi.useRealTimers();
});

describe("Passive sidebar PR indicators", () => {
  it("does not subscribe to PR status for session-only sidebar viewers", async () => {
    vi.useFakeTimers();
    const harness = createGatewayHarness(["operator.sessions.read", "operator.sessions.write"]);
    const row = {
      key: "agent:main:demo",
      isChild: false,
      worktreeId: "wt-demo",
    } as SidebarRecentSession;
    const host = mountLifecycleHost(harness.gateway, () => [row]);
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.request).not.toHaveBeenCalled();
    expect(host.indicators.summary(row.key, row.worktreeId ?? "")).toBeUndefined();
  });
  it("keeps empty rows idle across sidebar updates", async () => {
    vi.useFakeTimers();
    const harness = createGatewayHarness();
    const getRows = vi.fn(() => []);
    const host = mountLifecycleHost(harness.gateway, getRows);
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(0);

    host.requestUpdate();
    host.requestUpdate();
    expect(await host.updateComplete).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(host.textContent).toBe("");
    expect(harness.request).not.toHaveBeenCalled();
  });

  it.each(["merged"] as const)(
    "observes visible rows and keeps the pushed %s summary through backoff",
    async (state) => {
      vi.useFakeTimers();
      const harness = createGatewayHarness();
      const row = {
        key: "agent:main:demo",
        isChild: false,
        worktreeId: "wt-demo",
      } as SidebarRecentSession;
      const getRows = vi.fn(() => [row]);
      const host = mountLifecycleHost(harness.gateway, getRows);
      await host.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.request).not.toHaveBeenCalled();

      harness.emit({
        sessions: {
          [row.key]: {
            pullRequests: [
              { number: 2, state },
              {
                number: 1,
                owner: "openclaw",
                repo: "openclaw",
                branch: "feature/demo",
                title: "Demo",
                url: "https://example.test/pr/1",
                state,
              },
            ],
            rateLimited: true,
            status: "rate-limited",
          },
        },
      });
      await host.updateComplete;
      expect(host.indicators.summary(row.key, row.worktreeId ?? "")).toEqual({
        numbers: [1, 2],
        state,
      });

      harness.emit({
        sessions: {
          [row.key]: {
            pullRequests: [],
            rateLimited: true,
            status: "rate-limited",
          },
        },
      });
      await host.updateComplete;
      expect(host.indicators.summary(row.key, row.worktreeId ?? "")).toEqual({
        numbers: [1, 2],
        state,
      });

      harness.emit({
        sessions: {
          [row.key]: { pullRequests: [], rateLimited: false, status: "ready" },
        },
      });
      await host.updateComplete;
      expect(
        host.indicators.summary(row.key, row.worktreeId ?? "", { numbers: [99], state }),
      ).toBeUndefined();
      host.remove();
    },
  );

  it("clears alias indicators when the selected agent changes", async () => {
    vi.useFakeTimers();
    const harness = createGatewayHarness();
    const row = { key: "global", isChild: false, worktreeId: "wt-global" } as SidebarRecentSession;
    const host = mountLifecycleHost(harness.gateway, () => [row]);
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
    harness.emit({
      sessions: {
        "agent:main:global": {
          pullRequests: [
            {
              number: 1,
              owner: "openclaw",
              repo: "openclaw",
              branch: "feature/demo",
              title: "Demo",
              url: "https://example.test/pr/1",
              state: "open",
            },
          ],
          rateLimited: false,
          status: "ready",
        },
      },
    });
    await host.updateComplete;
    expect(host.indicators.summary(row.key, row.worktreeId ?? "")).toEqual({
      numbers: [1],
      state: "open",
    });

    host.selectedAgentId = "work";
    host.requestUpdate();
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(0);

    await host.updateComplete;
    expect(host.indicators.summary(row.key, row.worktreeId ?? "")).toBeUndefined();
  });

  it("clears a structural session's indicator while replacement data is pending", async () => {
    vi.useFakeTimers();
    const harness = createGatewayHarness();
    const row = {
      key: "agent:main:demo",
      isChild: false,
      worktreeId: "wt-demo",
    } as SidebarRecentSession;
    const epoch = {};
    const setPullRequestSummary = vi.fn();
    const host = mountLifecycleHost(
      harness.gateway,
      () => [row],
      () =>
        ({
          capturePullRequestEpoch: vi.fn(() => epoch),
          setPullRequestSummary,
        }) as unknown as SessionCapability,
    );
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
    harness.emit({
      sessions: {
        [row.key]: {
          pullRequests: [{ number: 1, state: "open" }],
          rateLimited: false,
          status: "ready",
        },
      },
    });
    await host.updateComplete;
    expect(host.indicators.summary(row.key, row.worktreeId ?? "")).toEqual({
      numbers: [1],
      state: "open",
    });

    harness.emit({ sessionKey: row.key, agentId: "main", reason: "rewind" }, "sessions.changed");

    await host.updateComplete;
    expect(host.indicators.summary(row.key, row.worktreeId ?? "")).toBeUndefined();
    expect(setPullRequestSummary).toHaveBeenCalledExactlyOnceWith(row.key, undefined, epoch);
  });
});

describe("Passive sidebar PR indicator lifecycle", () => {
  it.each(["agent", "client", "permissions", "sessions"] as const)(
    "retires %s scope while summaries are parked",
    async (change) => {
      const harness = createGatewayHarness();
      const sessions = createTestSessionCapability(harness.gateway);
      const row = {
        key: "global",
        isChild: false,
        worktreeId: "wt-global",
      } as SidebarRecentSession;
      const host = mountLifecycleHost(
        harness.gateway,
        () => [row],
        () => sessions,
      );
      await host.updateComplete;
      harness.emit({
        sessions: {
          "agent:main:global": {
            pullRequests: [{ number: 7, state: "open" }],
            rateLimited: false,
            status: "ready",
          },
        },
      });
      await host.updateComplete;
      expect(host.textContent).toBe("7");
      host.presented = false;
      host.requestUpdate();
      await host.updateComplete;

      const currentSessions =
        change === "sessions" ? createTestSessionCapability(harness.gateway) : sessions;
      const clearSummary = vi.spyOn(currentSessions, "setPullRequestSummary");
      if (change === "sessions") {
        host.getSessions = () => currentSessions;
      }
      if (change === "agent") {
        host.selectedAgentId = "work";
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
      host.requestUpdate();
      await host.updateComplete;
      const store = sessionPullRequestsForGateway(harness.gateway);
      expect(store.get("agent:main:global")).toBeUndefined();
      harness.emit({ sessionKey: "global", agentId: "main", reason: "rewind" }, "sessions.changed");
      await host.updateComplete;
      expect(clearSummary).not.toHaveBeenCalled();
      expect(host.textContent).toBe("7");
      expect(harness.request).not.toHaveBeenCalled();

      host.presented = true;
      host.requestUpdate();
      await host.updateComplete;
      expect(host.textContent).toBe("");
    },
  );
  it("hides the row's saved PR summary after a same-client read-scope revocation", async () => {
    const harness = createGatewayHarness();
    const row = {
      key: "agent:main:demo",
      isChild: false,
      worktreeId: "wt-demo",
      pullRequest: { numbers: [42], state: "open" },
    } as SidebarRecentSession;
    const host = mountLifecycleHost(harness.gateway, () => [row]);
    await host.updateComplete;
    expect(host.textContent).toContain("42");

    const snapshot = harness.gateway.snapshot;
    snapshot.hello = {
      ...snapshot.hello!,
      auth: { role: "operator", scopes: ["operator.sessions.read", "operator.sessions.write"] },
    };
    host.requestUpdate();
    await host.updateComplete;
    expect(host.textContent).not.toContain("42");
    expect(host.indicators.summary(row.key, row.worktreeId!, row.pullRequest)).toBeUndefined();

    snapshot.hello = {
      ...snapshot.hello,
      auth: { role: "operator", scopes: ["operator.read"] },
    };
    host.requestUpdate();
    await host.updateComplete;
    expect(host.textContent).toContain("42");
  });

  it("retains sidebar snapshots while only the viewed checkout drives subscriptions", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = createGatewayHarness();
    const rows = Array.from({ length: 40 }, (_, index) => ({
      key: `agent:main:demo-${index}`,
      isChild: false,
      worktreeId: `wt-demo-${index}`,
    })) as SidebarRecentSession[];
    const host = mountLifecycleHost(harness.gateway, () => rows);

    await host.updateComplete;
    await Promise.resolve();

    expect(harness.request).not.toHaveBeenCalled();

    const viewer = {};
    const store = sessionPullRequestsForGateway(harness.gateway);
    const key = rows[0]!.key;
    store.watch(viewer, [key], { foreground: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.request).toHaveBeenLastCalledWith(
      SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
      { sessionKeys: [key] },
      { timeoutMs: 30_000, signal: expect.any(AbortSignal) },
    );
    harness.emit({
      sessions: {
        [key]: {
          pullRequests: [{ number: 7, state: "open" }],
          rateLimited: false,
          status: "ready",
        },
      },
    });
    store.unwatch(viewer);
    await vi.advanceTimersByTimeAsync(0);
    await host.updateComplete;
    expect(harness.request).toHaveBeenLastCalledWith(
      SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
      { sessionKeys: [] },
      { timeoutMs: 30_000, signal: expect.any(AbortSignal) },
    );
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
      () => [
        {
          key,
          isChild: false,
          worktreeId: "wt-demo",
          pullRequest: sessions.pullRequestSummary(key),
        } as SidebarRecentSession,
      ],
      () => sessions,
    );
    const stop = sessions.subscribe(() => host.requestUpdate());
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
    harness.emit({
      sessions: {
        [key]: {
          pullRequests: [{ number: 7, state: "open" }],
          rateLimited: false,
          status: "ready",
        },
      },
    });
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
      host.requestUpdate();
      await host.updateComplete;
      await vi.advanceTimersByTimeAsync(0);
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
      stop();
      store.unwatch(foregroundOwner);
    }
  });

  it("keeps sidebar watches passive across disconnect and reconnect", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const harness = createGatewayHarness();
    const row = {
      key: "agent:main:demo",
      isChild: false,
      worktreeId: "wt-demo",
    } as SidebarRecentSession;
    const host = mountLifecycleHost(harness.gateway, () => [row]);
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.request).not.toHaveBeenCalled();

    host.requestUpdate();
    host.remove();
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.request).not.toHaveBeenCalled();

    document.body.append(host);
    host.requestUpdate();
    await host.updateComplete;
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.request).not.toHaveBeenCalled();
  });
});
