/* @vitest-environment jsdom */

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import type { RouteLocation } from "@openclaw/uirouter";
import type { PropertyValues } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditRunInspectResult } from "../../../../packages/gateway-protocol/src/schema/audit-run.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  GatewayRequestError,
  type GatewayBrowserClient,
  type GatewayHelloOk,
} from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
} from "../../app/gateway-store.test-support.ts";
import { loadSettings } from "../../app/settings.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import type { ActivityRouteData, RunInspectorState } from "./run-inspector-model.ts";
import type { SessionActivityController } from "./session-activity-controller.ts";
import type { ActivityEntry } from "./tool-activity.ts";
import * as activityView from "./view.ts";
import "./activity-page.ts";

type TestActivityPage = HTMLElement & {
  context: ApplicationContext;
  entries: ActivityEntry[];
  expandedIds: Set<string>;
  clearEntries: () => void;
  routeLocation?: RouteLocation;
  routeData?: ActivityRouteData;
  willUpdate: (changed: PropertyValues) => void;
  updated: (changed: PropertyValues) => void;
  render: () => unknown;
  requestUpdate: () => void;
  updateComplete: Promise<boolean>;
  runInspector: RunInspectorState;
  sessionActivity: SessionActivityController;
  loadRunInspector: (
    gateway: ApplicationContext["gateway"],
    client: GatewayBrowserClient,
    selector: { kind: "run"; id: string },
  ) => Promise<void>;
  subscriptions: {
    hostConnected: () => void;
    hostUpdate: () => void;
    hostDisconnected: () => void;
  };
};

function gateway(): ApplicationContext["gateway"] {
  const snapshot: ApplicationGatewaySnapshot = {
    client: null,
    phase: "stopped",
    offlineStable: false,
    canvasPluginSurfaceUrl: null,
    hello: null,
    assistantAgentId: null,
    sessionKey: "main",
    lastError: null,
    lastErrorCode: null,
  };
  return {
    snapshot,
    eventLog: [],
    eventLogRevision: 0,
    subscribe: vi.fn(() => () => undefined),
    subscribeEventLog: vi.fn(() => () => undefined),
    subscribeEvents: vi.fn(() => () => undefined),
  } as unknown as ApplicationContext["gateway"];
}

function staleEntry(): ActivityEntry {
  return {
    id: "stale",
    toolCallId: "stale",
    runId: "stale",
    toolName: "stale",
    entryKind: "tool",
    status: "done",
    startedAt: 0,
    updatedAt: 0,
    durationMs: 0,
    outputTruncated: false,
    summary: "stale",
    hiddenArgumentCount: 0,
  };
}

const activeGateways = new Set<ApplicationContext["gateway"]>();
const activePages = new Set<TestActivityPage>();
const activeSessions = new Map<ApplicationContext["gateway"], ApplicationContext["sessions"]>();
const activeAgents = new Map<ApplicationContext["gateway"], ApplicationContext["agents"]>();

function activityContext(source: ApplicationContext["gateway"]) {
  let sessions = activeSessions.get(source);
  if (!sessions) {
    sessions = createTestSessionCapability(source);
    activeSessions.set(source, sessions);
  }
  let agents = activeAgents.get(source);
  if (!agents) {
    agents = createAgentCapability(source);
    activeAgents.set(source, agents);
  }
  return { gateway: source, sessions, agents };
}

function activityHello(recoveryScope = "activity-owner-a"): GatewayHelloOk {
  return {
    type: "hello-ok",
    protocol: 1,
    auth: { role: "operator", scopes: ["operator.read"], recoveryScope },
  };
}

function activityGateway() {
  const store = createGatewayStoreTestStore({
    settings: {
      ...loadSettings(),
      gatewayUrl: "wss://activity.example.test",
      token: "",
      sessionKey: "main",
      lastActiveSessionKey: "main",
    },
  });
  activeGateways.add(store.gateway);
  activityContext(store.gateway);
  store.gateway.start();
  store
    .current()
    .request.mockImplementation(async (method, params) => activityResponse(method, params));
  store.current().opts.onHello?.(activityHello());
  return store;
}

function bindActivity(source: ApplicationContext["gateway"]): TestActivityPage {
  const page = document.createElement("openclaw-activity-page") as TestActivityPage;
  page.context = activityContext(source) as ApplicationContext;
  page.routeLocation = { pathname: "/activity", search: "?view=live", hash: "" };
  page.routeData = { mode: "live", selector: null };
  activePages.add(page);
  page.subscriptions.hostConnected();
  syncActivityRoster(page);
  return page;
}

function activityRoster(
  sessions: GatewaySessionRow[] = [
    { key: "main", kind: "direct", hasActiveRun: true },
    { key: "agent:other:work", kind: "direct", hasActiveRun: true },
  ],
): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: sessions.length,
    sessions,
    defaults: { model: null, modelProvider: null, contextTokens: null },
  };
}

function activityResponse(method: string, params: unknown) {
  switch (method) {
    case "sessions.list":
      return activityRoster();
    case "sessions.subscribe":
      return { subscribed: true };
    case "sessions.messages.subscribe":
      return params;
    default:
      return {};
  }
}

function syncActivityRoster(page: TestActivityPage, rows?: GatewaySessionRow[]) {
  page.sessionActivity.result = activityRoster(rows);
  page.updated(new Map());
}

function toolEvent(id: string, sessionKey = "main") {
  return createGatewayEvent("session.tool", {
    stream: "tool",
    runId: `run-${id}`,
    sessionKey,
    data: {
      toolCallId: id,
      name: "read",
      phase: "result",
      result: { text: `${id} output` },
    },
  });
}

afterEach(async () => {
  for (const page of activePages) {
    page.remove();
    page.subscriptions.hostDisconnected();
    page.sessionActivity.hostDisconnected();
  }
  for (const sessions of activeSessions.values()) {
    sessions.dispose();
  }
  for (const agents of activeAgents.values()) {
    agents.dispose();
  }
  for (const source of activeGateways) {
    source.stop();
  }
  // Credential changes start lazy cache cleanup; finish it before clearing the environment.
  await vi.dynamicImportSettled();
  activePages.clear();
  activeGateways.clear();
  activeSessions.clear();
  activeAgents.clear();
  setAvatarGatewayOrigin(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe("ActivityPage gateway lifecycle", () => {
  it.each(["sessions", "run"] as const)("skips Live Activity rendering in %s mode", (mode) => {
    const page = document.createElement("openclaw-activity-page") as TestActivityPage;
    page.context = { ...activityContext(gateway()), basePath: "" } as ApplicationContext;
    page.entries = [staleEntry()];
    page.routeLocation = {
      pathname: "/activity",
      search: mode === "run" ? "?view=run" : "",
      hash: "",
    };
    page.routeData =
      mode === "sessions"
        ? { mode, filters: { personId: null, query: "", time: "7d" }, selector: null }
        : { mode, selector: null, selectorId: null, decisionCursor: null };
    const render = vi.spyOn(activityView, "renderActivity");
    try {
      page.render();
      expect(render).not.toHaveBeenCalled();
      page.routeLocation = { pathname: "/activity", search: "?view=live", hash: "" };
      page.routeData = { mode: "live", selector: null };
      page.render();
      expect(render).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ entries: page.entries }),
      );
    } finally {
      render.mockRestore();
    }
  });

  it("starts empty on initial bind and source replacement", () => {
    const page = document.createElement("openclaw-activity-page") as TestActivityPage;
    page.context = activityContext(gateway()) as ApplicationContext;
    page.routeData = { mode: "live", selector: null };
    page.entries = [staleEntry()];

    page.subscriptions.hostConnected();
    expect(page.entries).toEqual([]);

    page.entries = [staleEntry()];
    page.context = activityContext(gateway()) as ApplicationContext;
    page.subscriptions.hostUpdate();
    expect(page.entries).toEqual([]);

    page.subscriptions.hostDisconnected();
  });

  it.each(["sessions", "run"] as const)("does not collect live events in %s mode", (mode) => {
    const { gateway: source, current } = activityGateway();
    const page = bindActivity(source);
    current().opts.onEvent?.(toolEvent("first"));
    const firstId = page.entries[0]!.id;
    page.expandedIds.add(firstId);
    page.routeData =
      mode === "sessions"
        ? { mode, filters: { personId: null, query: "", time: "7d" }, selector: null }
        : { mode, selector: null, selectorId: null, decisionCursor: null };
    page.updated(new Map());

    current().opts.onEvent?.(toolEvent("while-away"));

    page.routeData = { mode: "live", selector: null };
    syncActivityRoster(page);
    expect(page.entries.map((entry) => entry.outputPreview)).toEqual(["first output"]);
    expect([...page.expandedIds]).toEqual([firstId]);
    current().opts.onEvent?.(toolEvent("returned"));
    expect(page.entries.map((entry) => entry.outputPreview)).toEqual([
      "first output",
      "returned output",
    ]);
  });

  it("waits for route data before querying sessions on the first Gateway bind", () => {
    const { gateway: source, current } = activityGateway();
    const request = current().request.mockResolvedValue({
      ts: 1,
      path: "",
      count: 0,
      sessions: [],
      defaults: { model: null, modelProvider: null, contextTokens: null },
    });
    const page = document.createElement("openclaw-activity-page") as TestActivityPage;
    page.context = { ...activityContext(source), basePath: "" } as ApplicationContext;
    activePages.add(page);
    request.mockClear();

    page.subscriptions.hostConnected();

    expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toEqual([]);

    page.routeLocation = { pathname: "/activity", search: "?q=alpha", hash: "" };
    page.willUpdate(new Map([["routeLocation", undefined]]));

    expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toEqual([
      ["sessions.list", expect.objectContaining({ search: "alpha" }), expect.anything()],
    ]);
  });

  it.each(["gateway", "account"] as const)(
    "retires the mounted session's activity after a %s change",
    (change) => {
      const { gateway: source, current } = activityGateway();
      const page = bindActivity(source);
      current().opts.onEvent?.(toolEvent("old"));
      expect(page.entries.map((entry) => entry.outputPreview)).toEqual(["old output"]);
      page.expandedIds.add(page.entries[0]!.id);

      if (change === "gateway") {
        source.connect({ gatewayUrl: "wss://other-activity.example.test" });
      } else {
        current().opts.onClose?.({ code: 1006, reason: "reconnecting", willRetry: true });
        current().opts.onHello?.(activityHello("activity-owner-b"));
      }

      expect(page.entries).toEqual([]);
      expect(page.expandedIds.size).toBe(0);
      if (source.snapshot.phase !== "connected") {
        current().request.mockImplementation(async (method, params) =>
          activityResponse(method, params),
        );
        current().opts.onHello?.(activityHello());
      }
      syncActivityRoster(page);
      current().opts.onEvent?.(toolEvent("new"));
      expect(page.entries.map((entry) => entry.outputPreview)).toEqual(["new output"]);
    },
  );

  it("keeps streamed previews and expansion across ordinary appends and reconnects", () => {
    const { gateway: source, current } = activityGateway();
    const page = bindActivity(source);
    current().opts.onEvent?.(toolEvent("first"));
    const firstId = page.entries[0]!.id;
    page.expandedIds.add(firstId);

    current().opts.onEvent?.(toolEvent("second"));
    source.connect();
    current().opts.onHello?.(activityHello());

    expect(page.entries.map((entry) => entry.outputPreview)).toEqual([
      "first output",
      "second output",
    ]);
    expect([...page.expandedIds]).toEqual([firstId]);
  });

  it.each(["stop", "event"] as const)(
    "retires the roster before an earlier reset observer triggers a reentrant %s",
    (action) => {
      const { gateway: source, current } = activityGateway();
      let retiring = false;
      const unsubscribe = source.subscribeEventLog((events) => {
        if (!retiring || events.length > 0) {
          return;
        }
        retiring = false;
        if (action === "stop") {
          source.stop();
        } else {
          current().opts.onEvent?.(toolEvent("new-context"));
        }
      });
      try {
        const page = bindActivity(source);
        current().opts.onEvent?.(toolEvent("old"));
        retiring = true;

        source.connect({ gatewayUrl: "wss://other-activity.example.test" });

        expect(page.entries).toEqual([]);
        if (action === "stop") {
          expect(source.snapshot.phase).toBe("stopped");
        }
      } finally {
        unsubscribe();
      }
    },
  );

  it("starts each visit empty and ignores events received before opening", () => {
    const { gateway: source, current } = activityGateway();
    current().opts.onEvent?.(toolEvent("before-open"));
    const firstPage = bindActivity(source);
    expect(firstPage.entries).toEqual([]);
    current().opts.onEvent?.(toolEvent("first-visit"));
    expect(firstPage.entries.map((entry) => entry.outputPreview)).toEqual(["first-visit output"]);
    expect(source.eventLog).toEqual([]);
    firstPage.subscriptions.hostDisconnected();

    current().opts.onEvent?.(toolEvent("while-away"));
    const nextPage = bindActivity(source);
    expect(nextPage.entries).toEqual([]);
    current().opts.onEvent?.(toolEvent("next-visit"));
    expect(nextPage.entries.map((entry) => entry.outputPreview)).toEqual(["next-visit output"]);
    expect(firstPage.entries.map((entry) => entry.outputPreview)).toEqual(["first-visit output"]);
  });

  it.each(["tool", "answer_candidate"] as const)(
    "collects delivered %s activity only from the mounted roster",
    async (kind) => {
      const { gateway: source, current } = activityGateway();
      const page = bindActivity(source);
      const origins = [
        { runId: "selected", sessionKey: "main" },
        { runId: "other", sessionKey: "agent:research:work", agentId: "research" },
        { runId: "global", sessionKey: "global", agentId: "research" },
        { runId: "unknown", sessionKey: "unknown", agentId: "research" },
        { runId: "outside-roster", sessionKey: "agent:unrelated:work", agentId: "unrelated" },
        { runId: "unscoped" },
      ];
      const acquisitions = vi.spyOn(activityContext(source).sessions, "subscribeMessages");
      syncActivityRoster(page, [
        { key: "main", kind: "direct", hasActiveRun: true },
        { key: "agent:research:work", agentId: "research", kind: "direct" },
        { key: "global", agentId: "research", kind: "global" },
        { key: "unknown", agentId: "research", kind: "unknown" },
      ]);
      try {
        await Promise.all(acquisitions.mock.results.map((result) => result.value));
      } finally {
        acquisitions.mockRestore();
      }
      for (const origin of origins) {
        current().opts.onEvent?.(
          createGatewayEvent(kind === "tool" ? "session.tool" : "agent", {
            ...origin,
            stream: kind === "tool" ? "tool" : "item",
            data:
              kind === "tool"
                ? {
                    phase: "result",
                    name: "read",
                    toolCallId: "shared-call",
                    result: { text: `${origin.runId} output` },
                  }
                : {
                    kind: "answer_candidate",
                    itemId: "shared-item",
                    status: "selected",
                    progressText: `${origin.runId} output`,
                  },
          }),
        );
      }

      expect(page.entries.map((entry) => entry.runId)).toEqual([
        "selected",
        "other",
        "global",
        "unknown",
      ]);
      expect(new Set(page.entries.map((entry) => entry.id)).size).toBe(4);
      expect(current().request).toHaveBeenCalledWith(
        "sessions.messages.subscribe",
        { key: "unknown", agentId: "research" },
        expect.anything(),
      );
    },
  );

  it("releases only its own shared leases while hidden and on unmount", async () => {
    const { gateway: source, current } = activityGateway();
    const sessions = activityContext(source).sessions;
    const otherOwner = await sessions.subscribeMessages("main");
    const pending = createDeferred<{ key: string }>();
    current().request.mockImplementation(async (method, params) =>
      method === "sessions.messages.subscribe" ? pending.promise : activityResponse(method, params),
    );
    const page = bindActivity(source);
    const otherSession = sessions.subscribeMessages("agent:other:work");
    current().request.mockClear();

    globalThis.dispatchEvent(new Event("pagehide"));
    current().opts.onEvent?.(toolEvent("hidden"));
    pending.resolve({ key: "agent:other:work" });
    await sessions.unsubscribeMessages(await otherSession);
    const remainingOwner = await sessions.subscribeMessages("main");
    const unsubscribedKeys = () =>
      current()
        .request.mock.calls.filter(([method]) => method === "sessions.messages.unsubscribe")
        .map(([, params]) => params);
    expect(unsubscribedKeys()).not.toContainEqual({ key: "main" });
    await sessions.unsubscribeMessages(remainingOwner);
    await sessions.unsubscribeMessages(otherOwner);

    expect(page.entries).toEqual([]);
    expect(unsubscribedKeys()).toEqual(
      expect.arrayContaining([{ key: "main" }, { key: "agent:other:work" }]),
    );
    current().request.mockImplementation(async (method, params) =>
      activityResponse(method, params),
    );
    globalThis.dispatchEvent(new Event("pageshow"));
    current().opts.onEvent?.(toolEvent("visible"));
    expect(page.entries.map((entry) => entry.outputPreview)).toEqual(["visible output"]);
    page.subscriptions.hostDisconnected();
    current().opts.onEvent?.(toolEvent("unmounted"));
    expect(page.entries.map((entry) => entry.outputPreview)).toEqual(["visible output"]);
  });

  it("retires the connection when a failed release would leave an orphaned observer", async () => {
    const { gateway: source, current, clients } = activityGateway();
    const page = bindActivity(source);
    const previous = current();
    const previousIdentity = source.snapshot.client;
    const retired = createDeferred();
    const stop = source.subscribe((snapshot) => {
      if (snapshot.client !== previousIdentity) {
        retired.resolve();
      }
    });
    previous.request.mockImplementation(async (method, params) => {
      if (method === "sessions.messages.unsubscribe") {
        throw new Error("unsubscribe unavailable");
      }
      return activityResponse(method, params);
    });
    try {
      page.subscriptions.hostDisconnected();
      await retired.promise;
      expect(previous.stopped).toBe(1);
      expect(current()).not.toBe(previous);
      expect(clients).toHaveLength(2);
    } finally {
      stop();
    }
  });

  it("shows a failed subscription and recovers through the rendered Retry action", async () => {
    const { gateway: source, current } = activityGateway();
    const pending = createDeferred<{ key: string }>();
    current().request.mockImplementation(async (method, params) =>
      method === "sessions.messages.subscribe"
        ? pending.promise
        : method === "sessions.list"
          ? activityRoster([{ key: "main", kind: "direct", hasActiveRun: true }])
          : activityResponse(method, params),
    );
    const page = document.createElement("openclaw-activity-page") as TestActivityPage;
    page.context = { ...activityContext(source), basePath: "" } as ApplicationContext;
    page.routeLocation = { pathname: "/activity", search: "?view=live", hash: "" };
    activePages.add(page);
    document.body.append(page);
    await page.updateComplete;
    await page.sessionActivity.load(source.snapshot.client, "current");
    await page.updateComplete;
    const sessions = activityContext(source).sessions;
    const observer = sessions.subscribeMessages("main");

    pending.reject(new Error("Activity subscription unavailable"));
    await expect(observer).rejects.toThrow("Activity subscription unavailable");
    await page.updateComplete;

    const alert = page.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Activity subscription unavailable");
    const retry = alert?.querySelector("button");
    expect(retry?.textContent?.trim()).toBe("Retry");
    current().request.mockImplementation(async (method, params) =>
      activityResponse(method, params),
    );
    retry?.click();
    const recovered = await sessions.subscribeMessages("main");
    current().opts.onEvent?.(toolEvent("recovered"));
    await page.updateComplete;

    expect(page.querySelector('[role="alert"]')).toBeNull();
    expect(page.textContent).toContain("recovered output");
    await sessions.unsubscribeMessages(recovered);
  });

  it("preserves activity and Clear when the selected chat changes", () => {
    const { gateway: source, current } = activityGateway();
    const page = bindActivity(source);
    current().opts.onEvent?.(toolEvent("original"));
    const originalId = page.entries[0]!.id;
    page.expandedIds.add(originalId);
    source.setSessionKey("agent:other:work");

    expect(page.entries.map((entry) => entry.outputPreview)).toEqual(["original output"]);
    expect([...page.expandedIds]).toEqual([originalId]);
    current().opts.onEvent?.(toolEvent("other", "agent:other:work"));
    expect(page.entries.map((entry) => entry.outputPreview)).toEqual([
      "original output",
      "other output",
    ]);

    page.clearEntries();
    source.setSessionKey("main");
    expect(page.entries).toEqual([]);
    current().opts.onEvent?.(toolEvent("after-clear", "agent:other:work"));
    expect(page.entries.map((entry) => entry.outputPreview)).toEqual(["after-clear output"]);
  });

  it("stores the safe-only inspection response directly", async () => {
    const result = {
      schemaVersion: 1,
      run: { runId: "run-1", status: "unknown" },
      identity: {
        state: "unknown",
        reasonCode: "run_not_found",
        missingEvidence: ["run.record"],
        remediation: [],
      },
      decisionDisplays: [],
      coverage: { state: "unknown", missingEvidence: ["run.record"] },
    } satisfies AuditRunInspectResult;
    const client = { request: vi.fn(async () => result) } as unknown as GatewayBrowserClient;
    const activeGateway = {
      snapshot: { client, phase: "connected" },
    } as unknown as ApplicationContext["gateway"];
    const page = document.createElement("openclaw-activity-page") as TestActivityPage;
    page.context = { gateway: activeGateway } as unknown as ApplicationContext;
    const selector = { kind: "run", id: "run-1" } as const;
    page.routeLocation = { pathname: "/activity", search: "?view=run&run=run-1", hash: "" };
    page.routeData = {
      mode: "run",
      selector,
      selectorId: null,
      decisionCursor: null,
    };

    await page.loadRunInspector(activeGateway, client, selector);

    expect(page.runInspector.status).toBe("ready");
    if (page.runInspector.status === "ready") {
      expect(page.runInspector.result).toBe(result);
    }
  });

  it("retires a run inspector when route data disappears and excludes its late response", async () => {
    const result = {
      schemaVersion: 1,
      run: { runId: "run-1", status: "unknown" },
      identity: {
        state: "unknown",
        reasonCode: "run_not_found",
        missingEvidence: ["run.record"],
        remediation: [],
      },
      decisionDisplays: [],
      coverage: { state: "unknown", missingEvidence: ["run.record"] },
    } satisfies AuditRunInspectResult;
    const pending = createDeferred<AuditRunInspectResult>();
    const request = vi.fn(
      (_method: string, _params: unknown, _options?: { signal?: AbortSignal }) => pending.promise,
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const activeGateway = {
      snapshot: { client, phase: "connected" },
    } as unknown as ApplicationContext["gateway"];
    const page = document.createElement("openclaw-activity-page") as TestActivityPage;
    page.context = { gateway: activeGateway, basePath: "" } as unknown as ApplicationContext;
    const selector = { kind: "run", id: "run-1" } as const;
    page.routeLocation = { pathname: "/activity", search: "?view=run&run=run-1", hash: "" };
    page.routeData = { mode: "run", selector, selectorId: null, decisionCursor: null };
    const operation = page.loadRunInspector(activeGateway, client, selector);
    try {
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "audit.run.inspect",
        { runId: "run-1", decisionLimit: 50, executionLimit: 50 },
        { signal: expect.any(AbortSignal) },
      );
      const signal = request.mock.calls[0]?.[2]?.signal;
      expect(signal?.aborted).toBe(false);
      expect(page.runInspector.status).toBe("loading");

      const changed = new Map([["routeLocation", page.routeLocation]]);
      page.routeLocation = undefined;
      page.willUpdate(changed);
      page.updated(changed);

      expect(signal?.aborted).toBe(true);
      expect(page.runInspector).toEqual({ status: "empty" });
      pending.resolve(result);
      await operation;
      expect(page.runInspector).toEqual({ status: "empty" });
      expect(request).toHaveBeenCalledOnce();
    } finally {
      pending.resolve(result);
      await operation;
    }
  });

  it.each([
    [
      "protocol request",
      new GatewayProtocolRequestError({
        code: "INVALID_REQUEST",
        message: "decision cursor is no longer retained",
      }),
      "restart",
    ],
    [
      "UI Gateway request",
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "decision cursor is no longer retained",
      }),
      "restart",
    ],
    [
      "retryable invalid request",
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "temporarily unavailable",
        retryable: true,
      }),
      "retry",
    ],
    [
      "non-invalid request",
      new GatewayProtocolRequestError({ code: "UNAVAILABLE", message: "gateway unavailable" }),
      "retry",
    ],
  ] as const)("classifies a %s cursor failure", async (_label, error, recovery) => {
    const client = {
      request: vi.fn(() => Promise.reject(error)),
    } as unknown as GatewayBrowserClient;
    const activeGateway = {
      snapshot: { client, phase: "connected" },
    } as unknown as ApplicationContext["gateway"];
    const page = document.createElement("openclaw-activity-page") as TestActivityPage;
    page.context = { gateway: activeGateway } as unknown as ApplicationContext;
    const selector = { kind: "run", id: "run-1" } as const;
    page.routeLocation = {
      pathname: "/activity",
      search: "?view=run&run=run-1&receipt=receipt-1&decision=cursor-1",
      hash: "",
    };
    page.routeData = {
      mode: "run",
      selector,
      selectorId: "receipt-1",
      decisionCursor: "cursor-1",
    };

    await page.loadRunInspector(activeGateway, client, selector);

    expect(page.runInspector).toEqual({ status: "error", recovery });
  });
});
