/* @vitest-environment jsdom */

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import type { RouteLocation } from "@openclaw/uirouter";
import { createComponent, createEffect, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditRunInspectResult } from "../../../../packages/gateway-protocol/src/schema/audit-run.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
} from "../../app/gateway-store.test-support.ts";
import { loadSettings } from "../../app/settings.ts";
import { presentResult } from "../../e2e/activity-run-inspector.test-fixtures.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createActivityPageState } from "./activity-page-state.ts";
import { ActivityPageView } from "./activity-page-view.tsx";
import {
  activityHello,
  activityResponse,
  activityRoster,
  createActivityGatewayStub,
  inspectorGateway,
} from "./activity-page.test-support.ts";

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
    const page = createActivityPage(activityContext(createActivityGatewayStub()), {
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

  it("retains Current Work and local filters while the same client reconnects", async () => {
    const { gateway: source, current } = activityGateway();
    const page = await bindActivity(source);
    const filter = page.container.querySelector<HTMLInputElement>("input[type=search]")!;
    filter.value = "my draft filter";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    const rows = () => page.container.querySelectorAll(".activity-current-work__row");
    expect(rows()).toHaveLength(2);

    current().opts.onClose?.({ code: 1006, reason: "reconnecting", willRetry: true });
    flush();
    expect(rows()).toHaveLength(2);
    expect(filter.value).toBe("my draft filter");

    const failed = createDeferred<SessionsListResult>();
    current().request.mockImplementation(async (method, params) =>
      method === "sessions.list" ? failed.promise : activityResponse(method, params),
    );
    current().opts.onHello?.(activityHello());
    flush();
    expect(rows()).toHaveLength(2);
    expect(filter.value).toBe("my draft filter");
    failed.reject(new Error("Current Work refresh unavailable"));
    const retry = () =>
      page.container.querySelector<HTMLButtonElement>(".activity-current-work__feedback button");
    await waitForSolid(() => expect(retry()?.textContent?.trim()).toBe("Retry"));
    expect(page.container.querySelector(".activity-current-work__feedback")?.textContent).toContain(
      "Could not load active sessions",
    );
    expect(rows()).toHaveLength(2);
    const refreshed = createDeferred<SessionsListResult>();
    current().request.mockImplementation(async (method, params) =>
      method === "sessions.list" ? refreshed.promise : activityResponse(method, params),
    );
    retry()!.click();
    flush();
    expect(rows()).toHaveLength(2);
    refreshed.resolve(activityRoster([]));
    await waitForSolid(() => expect(rows()).toHaveLength(0));
    expect(retry()).toBeNull();
    expect(filter.value).toBe("my draft filter");
  });

  it("keeps reading Current Work across a session-scoped reconnect and clears it when read access is lost", async () => {
    const { gateway: source, current } = activityGateway();
    const hello = activityHello();
    hello.auth = { ...hello.auth, scopes: ["operator.sessions.read"] };
    current().opts.onHello?.(hello);
    const page = await bindActivity(source);
    const rows = () => page.container.querySelectorAll(".activity-current-work__row");
    expect(rows()).toHaveLength(2);

    current().opts.onClose?.({ code: 1006, reason: "reconnecting", willRetry: true });
    flush();
    expect(rows()).toHaveLength(2);
    const refreshed = createDeferred<SessionsListResult>();
    current().request.mockImplementation(async (method, params) =>
      method === "sessions.list" ? refreshed.promise : activityResponse(method, params),
    );
    current().opts.onHello?.({
      ...hello,
      auth: { ...hello.auth, scopes: ["operator.sessions.write"] },
    });
    flush();
    expect(rows()).toHaveLength(2);
    refreshed.resolve(
      activityRoster([
        { key: "main", kind: "direct", hasActiveRun: true, label: "Refreshed work" },
      ]),
    );
    await waitForSolid(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]?.textContent).toContain("Refreshed work");

    current().opts.onHello?.({ ...hello, auth: { ...hello.auth, scopes: [] } });
    flush();
    expect(rows()).toHaveLength(0);
  });

  it.each(["live", "run"] as const)(
    "retires %s data when the account changes without a client or event-log reset",
    async (mode) => {
      const { gateway: source, current } = activityGateway();
      if (mode === "run") {
        current().opts.onHello?.({
          ...activityHello(),
          features: { methods: ["audit.run.inspect"], events: [] },
        });
      }
      const attachAccount = (id: string) =>
        current().opts.onEvent?.(
          createGatewayEvent("presence", {
            presence: [{ instanceId: current().instanceId, user: { id } }],
          }),
        );
      attachAccount("reader-a");
      const result = presentResult("account-run");
      current().request.mockImplementation(async (method, params) =>
        method === "audit.run.inspect" ? result : activityResponse(method, params),
      );
      const page = createActivityPage(activityContext(source), {
        pathname: "/activity",
        search: mode === "run" ? "?view=run&run=account-run" : "?view=live",
        hash: "",
      });
      const visibleData = () =>
        page.container.querySelectorAll(
          mode === "run" ? ".run-inspector__receipt-list li" : ".activity-current-work__row",
        );
      await waitForSolid(() => expect(visibleData()).toHaveLength(mode === "run" ? 1 : 2));
      const stale = createDeferred<AuditRunInspectResult>();
      if (mode === "run") {
        current().request.mockImplementation(async () => stale.promise);
        page.container
          .querySelector<HTMLButtonElement>(".run-inspector__pagination button")!
          .click();
      } else {
        current().opts.onEvent?.(toolEvent("previous-account"));
        expect(previews(page)).toEqual(["previous-account output"]);
      }
      const replacement = createDeferred<AuditRunInspectResult | SessionsListResult>();
      current().request.mockImplementation(async (method, params) =>
        method === "audit.run.inspect" || method === "sessions.list"
          ? replacement.promise
          : activityResponse(method, params),
      );
      const client = source.snapshot.client;
      const revision = source.eventLogRevision;

      attachAccount("reader-b");
      flush();

      expect(source.snapshot.client).toBe(client);
      expect(source.eventLogRevision).toBe(revision);
      expect(visibleData()).toHaveLength(0);
      expect(previews(page)).toEqual([]);
      stale.resolve(result);
      await stale.promise;
      flush();
      expect(visibleData()).toHaveLength(0);
      replacement.resolve(mode === "run" ? result : activityRoster([]));
    },
  );

  it("retains inspected pages offline, refreshes them, and retires them on account change", async () => {
    const { gateway: source, current } = activityGateway();
    const hello = (recoveryScope = "activity-owner-a") => ({
      ...activityHello(recoveryScope),
      features: { methods: ["audit.run.inspect"], events: [] },
    });
    current().opts.onHello?.(hello());
    const first = presentResult("retained-run");
    const second = {
      ...first,
      decisionDisplays: [{ ...first.decisionDisplays[0]!, selectorId: "older-receipt" }],
      nextDecisionCursor: "older-cursor",
    };
    let inspection: Promise<AuditRunInspectResult> = Promise.resolve(first);
    current().request.mockImplementation(async (method, params) =>
      method === "audit.run.inspect" ? inspection : activityResponse(method, params),
    );
    const page = createActivityPage(activityContext(source), {
      pathname: "/activity",
      search: "?view=run&run=retained-run",
      hash: "",
    });
    const receipts = () => page.container.querySelectorAll(".run-inspector__receipt-list li");
    const loadMore = () =>
      page.container.querySelector<HTMLButtonElement>(".run-inspector__pagination button")!;
    await waitForSolid(() => expect(receipts()).toHaveLength(1));
    inspection = Promise.resolve(second);
    loadMore().click();
    await waitForSolid(() => expect(receipts()).toHaveLength(2));

    const stale = createDeferred<AuditRunInspectResult>();
    inspection = stale.promise;
    loadMore().click();
    current().opts.onClose?.({ code: 1006, reason: "reconnecting", willRetry: true });
    flush();
    expect(receipts()).toHaveLength(2);
    expect(loadMore().disabled).toBe(true);
    stale.resolve({
      ...second,
      decisionDisplays: [{ ...second.decisionDisplays[0]!, selectorId: "stale-receipt" }],
    });

    const failedRefresh = createDeferred<AuditRunInspectResult>();
    inspection = failedRefresh.promise;
    current().opts.onHello?.(hello());
    flush();
    expect(receipts()).toHaveLength(2);
    failedRefresh.reject(new Error("Run inspection refresh unavailable"));
    const retry = () =>
      page.container.querySelector<HTMLButtonElement>(".run-inspector__panel button");
    await waitForSolid(() => expect(retry()?.textContent?.trim()).toBe("Retry inspection"));
    expect(page.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Run inspection failed",
    );
    expect(receipts()).toHaveLength(2);
    const refresh = createDeferred<AuditRunInspectResult>();
    inspection = refresh.promise;
    retry()!.click();
    flush();
    expect(receipts()).toHaveLength(2);
    refresh.resolve({
      ...first,
      nextDecisionCursor: "fresh-cursor",
      decisionDisplays: [
        {
          ...first.decisionDisplays[0]!,
          action: { ...first.decisionDisplays[0]!.action, summary: "Fresh first-page evidence" },
        },
      ],
    });
    await waitForSolid(() =>
      expect(page.container.textContent).toContain("Fresh first-page evidence"),
    );
    expect(retry()).toBeNull();
    expect(receipts()).toHaveLength(2);
    inspection = Promise.resolve(second);
    loadMore().click();
    expect(current().request).toHaveBeenLastCalledWith(
      "audit.run.inspect",
      expect.objectContaining({ decisionCursor: "fresh-cursor" }),
      expect.anything(),
    );
    await waitForSolid(() => expect(loadMore().disabled).toBe(false));

    const replacement = createDeferred<AuditRunInspectResult>();
    inspection = replacement.promise;
    current().opts.onClose?.({ code: 1006, reason: "reconnecting", willRetry: true });
    current().opts.onHello?.(hello("activity-owner-b"));
    flush();
    expect(receipts()).toHaveLength(0);
    replacement.resolve(first);
  });

  it("makes new receipt pages reachable after reconnecting an exhausted run", async () => {
    const { gateway: source, current } = activityGateway();
    const hello = {
      ...activityHello(),
      features: { methods: ["audit.run.inspect"], events: [] },
    };
    current().opts.onHello?.(hello);
    const first = presentResult("growing-run");
    delete first.nextDecisionCursor;
    let inspection: AuditRunInspectResult = first;
    current().request.mockImplementation(async (method, params) =>
      method === "audit.run.inspect" ? inspection : activityResponse(method, params),
    );
    const page = createActivityPage(activityContext(source), {
      pathname: "/activity",
      search: "?view=run&run=growing-run",
      hash: "",
    });
    const receipts = () => page.container.querySelectorAll(".run-inspector__receipt-list li");
    const loadMore = () =>
      page.container.querySelector<HTMLButtonElement>(".run-inspector__pagination button");
    await waitForSolid(() => expect(receipts()).toHaveLength(1));
    expect(loadMore()).toBeNull();

    current().opts.onClose?.({ code: 1006, reason: "reconnecting", willRetry: true });
    flush();
    expect(receipts()).toHaveLength(1);
    inspection = {
      ...first,
      decisionDisplays: [{ ...first.decisionDisplays[0]!, selectorId: "new-first-page" }],
      nextDecisionCursor: "fresh-cursor",
    };
    current().opts.onHello?.(hello);
    await waitForSolid(() => expect(receipts()).toHaveLength(2));
    expect(loadMore()?.textContent?.trim()).toBe("Load more receipts");
    expect(loadMore()?.disabled).toBe(false);

    inspection = {
      ...first,
      decisionDisplays: [
        ...first.decisionDisplays,
        { ...first.decisionDisplays[0]!, selectorId: "next-page" },
      ],
    };
    loadMore()!.click();
    expect(current().request).toHaveBeenLastCalledWith(
      "audit.run.inspect",
      {
        runId: "growing-run",
        executionLimit: 50,
        decisionLimit: 50,
        decisionCursor: "fresh-cursor",
      },
      expect.anything(),
    );
    await waitForSolid(() => expect(receipts()).toHaveLength(3));
    expect(loadMore()).toBeNull();
  });

  it.each(["connected", "offline"] as const)(
    "clears run A evidence when selecting run B while %s, including after B fails",
    async (phase) => {
      const { gateway: source, current } = activityGateway();
      const hello = {
        ...activityHello(),
        features: { methods: ["audit.run.inspect"], events: [] },
      };
      current().opts.onHello?.(hello);
      const first = presentResult("run-a");
      const second = createDeferred<AuditRunInspectResult>();
      let inspection: Promise<AuditRunInspectResult> = Promise.resolve(first);
      current().request.mockImplementation(async (method, params) =>
        method === "audit.run.inspect" ? inspection : activityResponse(method, params),
      );
      const page = createActivityPage(activityContext(source), {
        pathname: "/activity",
        search: "?view=run&run=run-a",
        hash: "",
      });
      const receipts = () => page.container.querySelectorAll(".run-inspector__receipt-list li");
      await waitForSolid(() => expect(receipts()).toHaveLength(1));
      inspection = second.promise;
      if (phase === "offline") {
        current().opts.onClose?.({ code: 1006, reason: "reconnecting", willRetry: true });
        flush();
        expect(receipts()).toHaveLength(1);
      }

      page.setRouteLocation({ pathname: "/activity", search: "?view=run&run=run-b", hash: "" });
      expect(receipts()).toHaveLength(0);
      if (phase === "offline") {
        expect(current().request).not.toHaveBeenCalledWith(
          "audit.run.inspect",
          expect.objectContaining({ runId: "run-b" }),
          expect.anything(),
        );
        current().opts.onHello?.(hello);
        flush();
        expect(receipts()).toHaveLength(0);
      }
      expect(current().request).toHaveBeenCalledWith(
        "audit.run.inspect",
        expect.objectContaining({ runId: "run-b" }),
        expect.anything(),
      );
      second.reject(new Error("Run B inspection unavailable"));
      await waitForSolid(() =>
        expect(page.container.querySelector('[role="alert"] button')?.textContent).toBe(
          "Retry inspection",
        ),
      );
      expect(receipts()).toHaveLength(0);
    },
  );

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
    const container = page.container;
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

    const container = page.container;
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
    ],
    [
      "non-invalid request",
      new GatewayProtocolRequestError({ code: "UNAVAILABLE", message: "gateway unavailable" }),
      "retry",
    ],
  ] as const)(
    "keeps a %s cursor failure until explicit recovery",
    async (_label, error, recovery) => {
      const request = vi.fn(() => Promise.reject(error));
      const client = createTestGatewayClient(request);
      const activeGateway = inspectorGateway(client);
      const page = createActivityPage(activityContext(activeGateway), {
        pathname: "/activity",
        search: "?view=run&run=run-1&receipt=receipt-1&decision=cursor-1",
        hash: "",
      });
      await waitForSolid(() =>
        expect(page.container.querySelector('[role="alert"] button')?.textContent).toBe(
          recovery === "restart" ? "Restart inspection" : "Retry inspection",
        ),
      );
      page.setRouteLocation({
        pathname: "/activity",
        search: "?view=run&run=run-1&receipt=receipt-2&decision=cursor-1",
        hash: "",
      });
      expect(request).toHaveBeenCalledOnce();
      expect(page.container.querySelector('[role="alert"] button')?.textContent).toBe(
        recovery === "restart" ? "Restart inspection" : "Retry inspection",
      );
    },
  );
});
