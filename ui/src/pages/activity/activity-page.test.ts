/* @vitest-environment jsdom */

import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuditRunInspectResult } from "../../../../packages/gateway-protocol/src/schema/audit-run.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
} from "../../app/gateway-store.test-support.ts";
import { presentResult } from "../../e2e/activity-run-inspector.test-fixtures.ts";
import { createAgentIdentityCapability } from "../../lib/agents/identity.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  activityHello,
  activityResponse,
  activityRoster,
  activitySettings,
  inspectorGateway,
  createActivityPage,
  createActivityContext,
  type TestActivityPage,
} from "./activity-page.test-support.ts";

const activeGateways = new Set<ApplicationContext["gateway"]>();
const activeSessions = new Map<ApplicationContext["gateway"], ApplicationContext["sessions"]>();
const activeAgents = new Map<ApplicationContext["gateway"], ApplicationContext["agents"]>();
const activeIdentities = new Map<
  ApplicationContext["gateway"],
  ApplicationContext["agentIdentity"]
>();

function activityContext(source: ApplicationContext["gateway"], basePath = ""): ApplicationContext {
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
  let agentIdentity = activeIdentities.get(source);
  if (!agentIdentity) {
    agentIdentity = createAgentIdentityCapability(source);
    activeIdentities.set(source, agentIdentity);
  }
  return createActivityContext(source, { sessions, agents, agentIdentity }, basePath);
}

function activityGateway() {
  const store = createGatewayStoreTestStore({
    settings: activitySettings(),
  });
  activeGateways.add(store.gateway);
  activityContext(store.gateway);
  store.gateway.start();
  store
    .current()
    .request.mockImplementation(async (method, params) => activityResponse(method, params));
  store.current().testOptions.onHello?.(activityHello());
  return store;
}

async function bindActivity(
  source: ApplicationContext["gateway"],
  basePath = "",
): Promise<TestActivityPage> {
  const page = createActivityPage(activityContext(source, basePath), {
    pathname: `${basePath}/activity`,
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
  activeIdentities.clear();
  setAvatarGatewayOrigin(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe("ActivityPage gateway lifecycle", () => {
  it.each(["complete", "omitted"])(
    "preserves live and History routing for a %s roster message body",
    async (body) => {
      const active: GatewaySessionRow = {
        key: "agent:main:roster",
        agentId: "main",
        sessionId: "roster-session",
        kind: "direct",
        label: "Roster task",
        updatedAt: 100,
        status: "running",
        hasActiveRun: true,
        activeRunIds: ["roster-run"],
      };
      const { gateway: source, current } = activityGateway();
      current().request.mockImplementation(async (method, params) =>
        method === "sessions.list" ? activityRoster([active]) : activityResponse(method, params),
      );
      const context = activityContext(source);
      const selection = createAgentSelectionCapability(source, context.agents);
      Object.defineProperty(context, "agentSelection", { value: selection });
      const page = createActivityPage(context, {
        pathname: "/activity",
        search: "?view=live",
        hash: "",
      });
      await syncActivityRoster(page);
      vi.useFakeTimers();
      try {
        const message = (session: GatewaySessionRow) =>
          current().testOptions.onEvent?.(
            createGatewayEvent("session.message", {
              sessionKey: active.key,
              agentId: "main",
              messageId: "roster-message",
              messageSeq: 2,
              session,
              ancestorSessions: [],
              ...(body === "complete" ? { message: { role: "assistant", content: "Ready" } } : {}),
            }),
          );
        const listReads = () =>
          current().request.mock.calls.filter(
            ([method, params]) =>
              method === "sessions.list" && asOptionalRecord(params)?.source === "activity",
          ).length;
        const before = listReads();
        message({ ...active, updatedAt: 200 });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(page.container.querySelectorAll(".activity-current-work__row")).toHaveLength(1);
        expect(listReads()).toBe(before);
        message({
          ...active,
          updatedAt: 300,
          status: "done",
          hasActiveRun: false,
          activeRunIds: [],
        });
        await vi.advanceTimersByTimeAsync(0);
        flush();
        expect(page.container.querySelectorAll(".activity-current-work__row")).toHaveLength(0);
        expect(listReads()).toBe(before);

        page.setRouteLocation({ pathname: "/activity", search: "", hash: "" });
        await vi.advanceTimersByTimeAsync(0);
        flush();
        const historyReads = listReads();
        expect(page.container.querySelector(".activity-feed__session-title")?.textContent).toBe(
          "Roster task",
        );
        message({ ...active, updatedAt: 400, label: "Unexpected History update" });
        await vi.advanceTimersByTimeAsync(10_000);
        flush();
        expect(page.container.querySelector(".activity-feed__session-title")?.textContent).toBe(
          "Roster task",
        );
        expect(listReads()).toBe(historyReads);
      } finally {
        page.dispose();
        selection.dispose();
        vi.useRealTimers();
      }
    },
  );

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

  it("retains Current Work while the same client reconnects", async () => {
    const { gateway: source, current } = activityGateway();
    const page = await bindActivity(source);
    const rows = () => page.container.querySelectorAll(".activity-current-work__row");
    expect(rows()).toHaveLength(2);
    const firstRow = rows()[0];
    const currentWork = () => page.container.querySelector(".activity-current-work");

    current().testOptions.onClose?.({ code: 1006, reason: "reconnecting", willRetry: true });
    flush();
    expect(rows()).toHaveLength(2);

    const failed = createDeferred<SessionsListResult>();
    current().request.mockImplementation(async (method, params) =>
      method === "sessions.list" ? failed.promise : activityResponse(method, params),
    );
    current().testOptions.onHello?.(activityHello());
    flush();
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toBe(firstRow);
    expect(currentWork()?.getAttribute("aria-busy")).toBe("true");
    failed.reject(new Error("Current Work refresh unavailable"));
    const retry = () =>
      page.container.querySelector<HTMLButtonElement>(".activity-current-work__feedback button");
    await waitForSolid(() => expect(retry()?.textContent?.trim()).toBe("Retry"));
    expect(page.container.querySelector(".activity-current-work__feedback")?.textContent).toContain(
      "Couldn’t load active sessions. Try again.",
    );
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toBe(firstRow);
    expect(currentWork()?.getAttribute("aria-busy")).toBe("false");
    const refreshed = createDeferred<SessionsListResult>();
    current().request.mockImplementation(async (method, params) =>
      method === "sessions.list" ? refreshed.promise : activityResponse(method, params),
    );
    retry()!.click();
    flush();
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toBe(firstRow);
    expect(currentWork()?.getAttribute("aria-busy")).toBe("true");
    refreshed.resolve(activityRoster([]));
    await waitForSolid(() => expect(rows()).toHaveLength(0));
    expect(retry()).toBeNull();
  });

  it("keeps reading Current Work across a session-scoped reconnect and clears it when read access is lost", async () => {
    const { gateway: source, current } = activityGateway();
    const hello = activityHello();
    hello.auth = { ...hello.auth, scopes: ["operator.sessions.read"] };
    current().testOptions.onHello?.(hello);
    const page = await bindActivity(source);
    const rows = () => page.container.querySelectorAll(".activity-current-work__row");
    expect(rows()).toHaveLength(2);

    current().testOptions.onClose?.({ code: 1006, reason: "reconnecting", willRetry: true });
    flush();
    expect(rows()).toHaveLength(2);
    const refreshed = createDeferred<SessionsListResult>();
    current().request.mockImplementation(async (method, params) =>
      method === "sessions.list" ? refreshed.promise : activityResponse(method, params),
    );
    current().testOptions.onHello?.({
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

    current().testOptions.onHello?.({ ...hello, auth: { ...hello.auth, scopes: [] } });
    flush();
    expect(rows()).toHaveLength(0);
  });

  it.each(["live", "run"] as const)(
    "retires %s data when the account changes without a client or event-log reset",
    async (mode) => {
      const { gateway: source, current } = activityGateway();
      if (mode === "run") {
        current().testOptions.onHello?.({
          ...activityHello(),
          features: { methods: ["audit.run.inspect"], events: [] },
        });
      }
      let presenceVersion = 0;
      const attachAccount = (id: string) => {
        current().testOptions.onEvent?.(
          createGatewayEvent("presence", {
            reset: true,
            version: ++presenceVersion,
            keys: ["self"],
            presence: [{ instanceId: current().instanceId, user: { id } }],
          }),
        );
        expect(source.snapshot.selfUser?.id).toBe(id);
      };
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
    current().testOptions.onHello?.(hello());
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
    const nextPage = createDeferred<AuditRunInspectResult>();
    inspection = nextPage.promise;
    loadMore().click();
    flush();
    expect(receipts()).toHaveLength(1);
    expect(loadMore().disabled).toBe(true);
    expect(loadMore().textContent).toContain("Loading");
    nextPage.resolve(second);
    await waitForSolid(() => expect(receipts()).toHaveLength(2));

    const stale = createDeferred<AuditRunInspectResult>();
    inspection = stale.promise;
    loadMore().click();
    current().testOptions.onClose?.({ code: 1006, reason: "reconnecting", willRetry: true });
    flush();
    expect(receipts()).toHaveLength(2);
    expect(loadMore().disabled).toBe(true);
    stale.resolve({
      ...second,
      decisionDisplays: [{ ...second.decisionDisplays[0]!, selectorId: "stale-receipt" }],
    });

    const failedRefresh = createDeferred<AuditRunInspectResult>();
    inspection = failedRefresh.promise;
    current().testOptions.onHello?.(hello());
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
    current().testOptions.onClose?.({ code: 1006, reason: "reconnecting", willRetry: true });
    current().testOptions.onHello?.(hello("activity-owner-b"));
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
    current().testOptions.onHello?.(hello);
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

    current().testOptions.onClose?.({ code: 1006, reason: "reconnecting", willRetry: true });
    flush();
    expect(receipts()).toHaveLength(1);
    inspection = {
      ...first,
      decisionDisplays: [{ ...first.decisionDisplays[0]!, selectorId: "new-first-page" }],
      nextDecisionCursor: "fresh-cursor",
    };
    current().testOptions.onHello?.(hello);
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
      current().testOptions.onHello?.(hello);
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
        current().testOptions.onClose?.({ code: 1006, reason: "reconnecting", willRetry: true });
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
        current().testOptions.onHello?.(hello);
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
  ] as const)(
    "keeps a %s failure until explicit recovery",
    async (_label, error, recovery, hasCursor) => {
      const request = vi.fn(() => Promise.reject(error));
      const client = createTestGatewayClient(request);
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
      page.setRouteLocation({
        pathname: "/activity",
        search: `?view=run&run=run-1&receipt=receipt-2${hasCursor ? "&decision=cursor-1" : ""}`,
        hash: "",
      });
      expect(request).toHaveBeenCalledOnce();
      expect(page.container.querySelector('[role="alert"] button')?.textContent).toBe(
        recovery === "restart" ? "Restart inspection" : "Retry inspection",
      );
    },
  );
});
