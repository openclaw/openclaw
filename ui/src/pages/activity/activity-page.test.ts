/* @vitest-environment jsdom */

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import type { RouteLocation } from "@openclaw/uirouter";
import { createComponent, createEffect, createSignal } from "solid-js";
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
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createActivityPageState } from "./activity-page-state.ts";
import { ActivityPageView } from "./activity-page-view.tsx";

type TestActivityPage = ReturnType<typeof createActivityPage>;

function createActivityPage(context: ApplicationContext, initial?: RouteLocation) {
  const [location, setLocation] = createSignal(initial);
  const mounted = mountSolid(() => {
    const page = createActivityPageState(context);
    createEffect(location, (next) => page.setRouteLocation(next));
    return createComponent(ActivityPageView, { page });
  });
  flush();
  return {
    context,
    container: mounted.container,
    dispose: mounted.unmount,
    setRouteLocation(next: RouteLocation | undefined) {
      setLocation(next);
      flush();
    },
  };
}

function inspectorGateway(client: GatewayBrowserClient) {
  const source = gateway();
  Object.assign(source.snapshot, {
    client,
    phase: "connected",
    hello: {
      ...activityHello(),
      features: { methods: ["audit.run.inspect"], events: [] },
    },
  });
  return source;
}

function previews(page: TestActivityPage) {
  flush();
  return [...page.container.querySelectorAll(".activity-entry__preview")].map(
    (entry) => entry.textContent,
  );
}

function expandFirst(page: TestActivityPage) {
  flush();
  const row = page.container.querySelector<HTMLDetailsElement>(".activity-entry")!;
  row.open = true;
  row.dispatchEvent(new Event("toggle"));
  flush();
  return row;
}

function mountActivityPage(page: TestActivityPage) {
  return page.container;
}

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

const activeGateways = new Set<ApplicationContext["gateway"]>();
const activeSessions = new Map<ApplicationContext["gateway"], ApplicationContext["sessions"]>();
const activeAgents = new Map<ApplicationContext["gateway"], ApplicationContext["agents"]>();

function activityContext(source: ApplicationContext["gateway"]): ApplicationContext {
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
  return {
    gateway: source,
    sessions,
    agents,
    basePath: "",
    resourceBasePath: "",
    replace: vi.fn(),
    navigate: vi.fn(),
    navigateAndWait: vi.fn(async () => {}),
    revalidate: vi.fn(async () => {}),
    preload: vi.fn(async () => {}),
    nativeDeviceSettings: null,
    nativeNotifications: null,
    // These tests exercise Activity only; unexpected capability reads must fail.
    get router(): never {
      throw new Error("Activity fixture does not provide router");
    },
    get connectionBootstrap(): never {
      throw new Error("Activity fixture does not provide connectionBootstrap");
    },
    get agentIdentity(): never {
      throw new Error("Activity fixture does not provide agentIdentity");
    },
    get agentSelection(): never {
      throw new Error("Activity fixture does not provide agentSelection");
    },
    get settingsAgentSelection(): never {
      throw new Error("Activity fixture does not provide settingsAgentSelection");
    },
    get channels(): never {
      throw new Error("Activity fixture does not provide channels");
    },
    get config(): never {
      throw new Error("Activity fixture does not provide config");
    },
    get scopeUpgrade(): never {
      throw new Error("Activity fixture does not provide scopeUpgrade");
    },
    get sidebarAttention(): never {
      throw new Error("Activity fixture does not provide sidebarAttention");
    },
    get runtimeConfig(): never {
      throw new Error("Activity fixture does not provide runtimeConfig");
    },
    get placementStartup(): never {
      throw new Error("Activity fixture does not provide placementStartup");
    },
    get plugins(): never {
      throw new Error("Activity fixture does not provide plugins");
    },
    get assistantDock(): never {
      throw new Error("Activity fixture does not provide assistantDock");
    },
    get overlays(): never {
      throw new Error("Activity fixture does not provide overlays");
    },
    get navigation(): never {
      throw new Error("Activity fixture does not provide navigation");
    },
    get theme(): never {
      throw new Error("Activity fixture does not provide theme");
    },
    get nativeChatDrafts(): never {
      throw new Error("Activity fixture does not provide nativeChatDrafts");
    },
    get webPush(): never {
      throw new Error("Activity fixture does not provide webPush");
    },
    get chatSubmissions(): never {
      throw new Error("Activity fixture does not provide chatSubmissions");
    },
    get chatAttachmentHandoff(): never {
      throw new Error("Activity fixture does not provide chatAttachmentHandoff");
    },
  };
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

async function bindActivity(source: ApplicationContext["gateway"]): Promise<TestActivityPage> {
  const page = createActivityPage(activityContext(source), {
    pathname: "/activity",
    search: "?view=live",
    hash: "",
  });
  await syncActivityRoster(page);
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

async function syncActivityRoster(page: TestActivityPage) {
  await waitForSolid(() =>
    expect(page.container.querySelectorAll(".activity-current-work__row").length).toBeGreaterThan(
      0,
    ),
  );
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
  cleanupSolid();
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
  activeGateways.clear();
  activeSessions.clear();
  activeAgents.clear();
  setAvatarGatewayOrigin(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe("ActivityPage gateway lifecycle", () => {
  it.each(["sessions", "run"] as const)("skips Live Activity rendering in %s mode", (mode) => {
    const page = createActivityPage(activityContext(gateway()), {
      pathname: "/activity",
      search: mode === "run" ? "?view=run" : "",
      hash: "",
    });
    expect(page.container.querySelector(".activity-page")).toBeNull();
    page.setRouteLocation({ pathname: "/activity", search: "?view=live", hash: "" });
    expect(page.container.querySelector(".activity-page")).not.toBeNull();
  });

  it("starts empty on initial bind and source replacement", async () => {
    const first = activityGateway();
    const page = await bindActivity(first.gateway);
    first.current().opts.onEvent?.(toolEvent("old"));
    expect(previews(page)).toEqual(["old output"]);
    page.dispose();
    const next = activityGateway();
    const replacement = await bindActivity(next.gateway);
    expect(previews(replacement)).toEqual([]);
  });

  it("does not collect live events in sessions mode", async () => {
    const { gateway: source, current } = activityGateway();
    const page = await bindActivity(source);
    current().opts.onEvent?.(toolEvent("first"));
    expandFirst(page);
    page.setRouteLocation({ pathname: "/activity", search: "", hash: "" });
    current().opts.onEvent?.(toolEvent("while-away"));
    page.setRouteLocation({ pathname: "/activity", search: "?view=live", hash: "" });
    await syncActivityRoster(page);
    expect(previews(page)).toEqual(["first output"]);
    expect(page.container.querySelector<HTMLDetailsElement>(".activity-entry")?.open).toBe(true);
    current().opts.onEvent?.(toolEvent("returned"));
    expect(previews(page)).toEqual(["first output", "returned output"]);
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
    request.mockClear();
    const page = createActivityPage(activityContext(source));

    expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toEqual([]);

    page.setRouteLocation({ pathname: "/activity", search: "?q=alpha", hash: "" });

    expect(request.mock.calls.filter(([method]) => method === "sessions.list")).toEqual([
      ["sessions.list", expect.objectContaining({ search: "alpha" }), expect.anything()],
    ]);
  });

  it("retires the mounted session's activity after an account change", async () => {
    const { gateway: source, current } = activityGateway();
    const page = await bindActivity(source);
    current().opts.onEvent?.(toolEvent("old"));
    expect(previews(page)).toEqual(["old output"]);
    expandFirst(page);

    current().opts.onClose?.({ code: 1006, reason: "reconnecting", willRetry: true });
    current().opts.onHello?.(activityHello("activity-owner-b"));

    expect(previews(page)).toEqual([]);
    flush();
    expect(page.container.querySelectorAll(".activity-entry[open]")).toHaveLength(0);
    if (source.snapshot.phase !== "connected") {
      current().request.mockImplementation(async (method, params) =>
        activityResponse(method, params),
      );
      current().opts.onHello?.(activityHello());
    }
    await syncActivityRoster(page);
    current().opts.onEvent?.(toolEvent("new"));
    expect(previews(page)).toEqual(["new output"]);
  });

  it("keeps streamed previews and expansion across ordinary appends and reconnects", async () => {
    const { gateway: source, current } = activityGateway();
    const page = await bindActivity(source);
    current().opts.onEvent?.(toolEvent("first"));
    const firstRow = expandFirst(page);

    current().opts.onEvent?.(toolEvent("second"));
    source.connect();
    current().opts.onHello?.(activityHello());

    expect(previews(page)).toEqual(["first output", "second output"]);
    expect(firstRow.open).toBe(true);
    expect(page.container.querySelector(".activity-entry")).toBe(firstRow);
  });

  it.each(["stop", "event"] as const)(
    "retires the roster before an earlier reset observer triggers a reentrant %s",
    async (action) => {
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
        const page = await bindActivity(source);
        current().opts.onEvent?.(toolEvent("old"));
        retiring = true;

        source.connect({ gatewayUrl: "wss://other-activity.example.test" });

        expect(previews(page)).toEqual([]);
        if (action === "stop") {
          expect(source.snapshot.phase).toBe("stopped");
        }
      } finally {
        unsubscribe();
      }
    },
  );

  it("starts each visit empty and ignores events received before opening", async () => {
    const { gateway: source, current } = activityGateway();
    current().opts.onEvent?.(toolEvent("before-open"));
    const firstPage = await bindActivity(source);
    expect(previews(firstPage)).toEqual([]);
    current().opts.onEvent?.(toolEvent("first-visit"));
    expect(previews(firstPage)).toEqual(["first-visit output"]);
    expect(source.eventLog).toEqual([]);
    firstPage.dispose();

    current().opts.onEvent?.(toolEvent("while-away"));
    const nextPage = await bindActivity(source);
    expect(previews(nextPage)).toEqual([]);
    current().opts.onEvent?.(toolEvent("next-visit"));
    expect(previews(nextPage)).toEqual(["next-visit output"]);
    expect(previews(nextPage)).not.toContain("first-visit output");
  });

  it("collects delivered answer candidates only from the mounted roster", async () => {
    const { gateway: source, current } = activityGateway();
    const roster = activityRoster([
      { key: "main", kind: "direct", hasActiveRun: true },
      { key: "agent:research:work", agentId: "research", kind: "direct", hasActiveRun: true },
      { key: "global", agentId: "research", kind: "global", hasActiveRun: true },
      { key: "unknown", agentId: "research", kind: "unknown", hasActiveRun: true },
    ]);
    current().request.mockImplementation(async (method, params) =>
      method === "sessions.list" ? roster : activityResponse(method, params),
    );
    const origins = [
      { runId: "selected", sessionKey: "main" },
      { runId: "other", sessionKey: "agent:research:work", agentId: "research" },
      { runId: "global", sessionKey: "global", agentId: "research" },
      { runId: "unknown", sessionKey: "unknown", agentId: "research" },
      { runId: "outside-roster", sessionKey: "agent:unrelated:work", agentId: "unrelated" },
      { runId: "unscoped" },
    ];
    const acquisitions = vi.spyOn(activityContext(source).sessions, "subscribeMessages");
    const page = createActivityPage(activityContext(source), {
      pathname: "/activity",
      search: "?view=live",
      hash: "",
    });
    try {
      await syncActivityRoster(page);
      await Promise.all(acquisitions.mock.results.map((result) => result.value));
    } finally {
      acquisitions.mockRestore();
    }
    for (const origin of origins) {
      current().opts.onEvent?.(
        createGatewayEvent("agent", {
          ...origin,
          stream: "item",
          data: {
            kind: "answer_candidate",
            itemId: "shared-item",
            status: "selected",
            progressText: `${origin.runId} output`,
          },
        }),
      );
    }

    flush();
    expect(
      [...page.container.querySelectorAll<HTMLAnchorElement>(".activity-entry__run-link")].map(
        (link) => new URL(link.href).searchParams.get("run"),
      ),
    ).toEqual(["selected", "other", "global", "unknown"]);
    expect(page.container.querySelectorAll(".activity-entry")).toHaveLength(4);
    expect(current().request).toHaveBeenCalledWith(
      "sessions.messages.subscribe",
      { key: "unknown", agentId: "research", subscriptionId: expect.any(String) },
      expect.anything(),
    );
  });

  it("releases only its own shared leases while hidden and on unmount", async () => {
    const { gateway: source, current } = activityGateway();
    const sessions = activityContext(source).sessions;
    const otherOwner = await sessions.subscribeMessages("main");
    const pending = createDeferred<{ key: string }>();
    current().request.mockImplementation(async (method, params) =>
      method === "sessions.messages.subscribe" ? pending.promise : activityResponse(method, params),
    );
    const page = await bindActivity(source);
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
    expect(unsubscribedKeys()).not.toContainEqual(expect.objectContaining({ key: "main" }));
    await sessions.unsubscribeMessages(remainingOwner);
    await sessions.unsubscribeMessages(otherOwner);

    expect(previews(page)).toEqual([]);
    expect(unsubscribedKeys()).toEqual(
      expect.arrayContaining([
        { key: "main", subscriptionId: expect.any(String) },
        { key: "agent:other:work", subscriptionId: expect.any(String) },
      ]),
    );
    current().request.mockImplementation(async (method, params) =>
      activityResponse(method, params),
    );
    globalThis.dispatchEvent(new Event("pageshow"));
    current().opts.onEvent?.(toolEvent("visible"));
    expect(previews(page)).toEqual(["visible output"]);
    page.dispose();
    current().opts.onEvent?.(toolEvent("unmounted"));
    expect(page.container.isConnected).toBe(false);
  });

  it("retires the connection when a failed release would leave an orphaned observer", async () => {
    const { gateway: source, current, clients } = activityGateway();
    const page = await bindActivity(source);
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
      page.dispose();
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
    const page = createActivityPage(activityContext(source), {
      pathname: "/activity",
      search: "?view=live",
      hash: "",
    });
    const container = mountActivityPage(page);
    await syncActivityRoster(page);
    flush();
    const sessions = activityContext(source).sessions;
    const observer = sessions.subscribeMessages("main");

    pending.reject(new Error("Activity subscription unavailable"));
    await expect(observer).rejects.toThrow("Activity subscription unavailable");
    flush();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Activity subscription unavailable");
    const retry = alert?.querySelector("button");
    expect(retry?.textContent?.trim()).toBe("Retry");
    current().request.mockImplementation(async (method, params) =>
      activityResponse(method, params),
    );
    retry?.click();
    const recovered = await sessions.subscribeMessages("main");
    current().opts.onEvent?.(toolEvent("recovered"));
    flush();

    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain("recovered output");
    await sessions.unsubscribeMessages(recovered);
  });

  it("preserves activity and Clear when the selected chat changes", async () => {
    const { gateway: source, current } = activityGateway();
    const page = await bindActivity(source);
    current().opts.onEvent?.(toolEvent("original"));
    const originalRow = expandFirst(page);
    source.setSessionKey("agent:other:work");

    expect(previews(page)).toEqual(["original output"]);
    expect(originalRow.open).toBe(true);
    expect(page.container.querySelector(".activity-entry")).toBe(originalRow);
    current().opts.onEvent?.(toolEvent("other", "agent:other:work"));
    expect(previews(page)).toEqual(["original output", "other output"]);

    const container = mountActivityPage(page);
    const clear = container.querySelector<HTMLButtonElement>(".activity-page button.danger");
    expect(clear?.textContent?.trim()).toBe("Clear");
    clear?.click();
    source.setSessionKey("main");
    expect(previews(page)).toEqual([]);
    current().opts.onEvent?.(toolEvent("after-clear", "agent:other:work"));
    expect(previews(page)).toEqual(["after-clear output"]);
  });

  it("renders the safe-only inspection response through its route", async () => {
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
    const request = vi.fn(async () => result);
    const client = createTestGatewayClient(request);
    const activeGateway = inspectorGateway(client);
    const page = createActivityPage(activityContext(activeGateway), {
      pathname: "/activity",
      search: "?view=run&run=run-1",
      hash: "",
    });
    await waitForSolid(() =>
      expect(page.container.querySelector(".run-inspector__result-state")?.textContent).toContain(
        "run_not_found",
      ),
    );
    expect(request).toHaveBeenCalledWith(
      "audit.run.inspect",
      { runId: "run-1", decisionLimit: 50, executionLimit: 50 },
      { signal: expect.any(AbortSignal) },
    );
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
    const client = createTestGatewayClient(request);
    const activeGateway = inspectorGateway(client);
    const page = createActivityPage(activityContext(activeGateway), {
      pathname: "/activity",
      search: "?view=run&run=run-1",
      hash: "",
    });
    try {
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "audit.run.inspect",
        { runId: "run-1", decisionLimit: 50, executionLimit: 50 },
        { signal: expect.any(AbortSignal) },
      );
      const signal = request.mock.calls[0]?.[2]?.signal;
      expect(signal?.aborted).toBe(false);
      expect(page.container.querySelector(".run-inspector__panel")).not.toBeNull();

      page.setRouteLocation(undefined);

      expect(signal?.aborted).toBe(true);
      expect(page.container.querySelector(".run-inspector")).toBeNull();
      pending.resolve(result);
      await pending.promise;
      flush();
      expect(page.container.querySelector(".run-inspector")).toBeNull();
      expect(request).toHaveBeenCalledOnce();
    } finally {
      pending.resolve(result);
      await pending.promise;
      flush();
    }
  });

  it.each([
    [
      "UI Gateway request",
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "decision cursor is no longer retained",
      }),
      "restart",
      true,
    ],
    [
      "unknown inspection method without a cursor",
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "unknown method: audit.run.inspect",
      }),
      "retry",
      false,
    ],
    [
      "unexpected admin scope without a cursor",
      new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "missing scope: operator.admin",
      }),
      "retry",
      false,
    ],
    [
      "non-invalid request",
      new GatewayProtocolRequestError({ code: "UNAVAILABLE", message: "gateway unavailable" }),
      "retry",
      true,
    ],
  ] as const)("classifies a %s failure", async (_label, error, recovery, hasCursor) => {
    const client = createTestGatewayClient(vi.fn(() => Promise.reject(error)));
    const activeGateway = inspectorGateway(client);
    const page = createActivityPage(activityContext(activeGateway), {
      pathname: "/activity",
      search: `?view=run&run=run-1${hasCursor ? "&receipt=receipt-1&decision=cursor-1" : ""}`,
      hash: "",
    });
    await waitForSolid(() =>
      expect(page.container.querySelector('[role="alert"] button')?.textContent).toBe(
        recovery === "restart" ? "Restart inspection" : "Retry inspection",
      ),
    );
  });
});
