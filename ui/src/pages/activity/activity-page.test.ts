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
import { i18n } from "../../i18n/index.ts";
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
  createActivityGatewayStub,
  inspectorGateway,
  createActivityPage,
  createActivityContext,
  expandFirst,
  previews,
  toolEvent,
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

  it("renders localized summaries and timestamps across locale changes", async () => {
    const previousLocale = i18n.getLocale();
    const timestamp = Date.UTC(2026, 0, 2, 15, 4, 55);
    const { gateway: source, current } = activityGateway();
    const { container } = await bindActivity(source);
    const now = vi.spyOn(Date, "now");
    try {
      for (const [index, updatedAt] of [
        0,
        timestamp,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        8_640_000_000_000_001,
      ].entries()) {
        now.mockReturnValue(updatedAt);
        current().testOptions.onEvent?.(
          createGatewayEvent("session.tool", {
            stream: "tool",
            runId: `time-${index}`,
            sessionKey: "main",
            ts: updatedAt - 119_900,
            data: {
              toolCallId: `time-${index}`,
              name: "exec",
              phase: "result",
              result: { text: "ok" },
            },
          }),
        );
      }
    } finally {
      now.mockRestore();
    }
    const options: Intl.DateTimeFormatOptions = {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    };
    try {
      for (const [locale, summary] of [
        ["en", "0 arguments hidden"],
        ["de", "0 Argumente ausgeblendet"],
      ] as const) {
        await i18n.setLocale(locale);
        await waitForSolid(() =>
          expect(container.querySelector(".activity-entry__text")?.textContent?.trim()).toBe(
            summary,
          ),
        );
        expect(container.querySelector(".activity-entry__meta")?.textContent).toContain("2m");
        expect(
          Array.from(
            container.querySelectorAll(".activity-entry__meta > span:first-child"),
            (element) => element.textContent,
          ),
        ).toEqual([
          new Date(0).toLocaleTimeString(locale, options),
          new Date(timestamp).toLocaleTimeString(locale, options),
          "",
          "",
          "",
        ]);
      }
    } finally {
      await i18n.setLocale(previousLocale);
    }
  });

  it("keeps primary live filters visible and moves the tool picker into the filter disclosure", async () => {
    await i18n.setLocale("en");
    const { gateway: source, current } = activityGateway();
    const { container } = await bindActivity(source, "/control");
    current().testOptions.onEvent?.(toolEvent("Mu\u0308nchen", "main", "exec", "live run:a/b"));
    current().testOptions.onEvent?.(toolEvent("Caf\u00e9"));
    const toolbar = container.querySelector(".activity-live-toolbar");
    expect(
      toolbar?.querySelectorAll('.activity-status-filter input[type="checkbox"]'),
    ).toHaveLength(3);
    expect(
      toolbar?.querySelector(".activity-live-autofollow input.settings-toggle__input"),
    ).not.toBeNull();
    const filterTrigger = toolbar?.querySelector<HTMLButtonElement>(
      "#activity-live-filter-trigger",
    );
    expect(filterTrigger?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(filterTrigger?.getAttribute("aria-expanded")).toBe("false");
    await waitForSolid(() =>
      expect(container.querySelector(".activity-entry__run-link")?.getAttribute("href")).toBe(
        "/control/activity?view=run&run=live%20run%3Aa%2Fb",
      ),
    );
    filterTrigger?.click();
    expect(document.activeElement).toBe(container.querySelector(".activity-live-filter-popover"));

    const done = toolbar?.querySelectorAll<HTMLInputElement>(
      '.activity-status-filter input[type="checkbox"]',
    )[1];
    done?.click();
    flush();
    expect(container.querySelectorAll(".activity-entry")).toHaveLength(0);
    done?.click();
    flush();
    expect(container.querySelectorAll(".activity-entry")).toHaveLength(2);

    const follow = toolbar?.querySelector<HTMLInputElement>(
      ".activity-live-autofollow input.settings-toggle__input",
    );
    follow?.click();
    flush();
    expect(follow?.checked).toBe(false);
    follow?.click();
    flush();
    expect(follow?.checked).toBe(true);

    const [expand, collapse] = container.querySelectorAll<HTMLButtonElement>(
      ".activity-page .settings-section__actions button",
    );
    const expansionState = () =>
      Array.from(
        container.querySelectorAll<HTMLDetailsElement>(".activity-entry"),
        (row) => row.open,
      );
    expand?.click();
    flush();
    expect(expansionState()).toEqual([true, true]);
    collapse?.click();
    flush();
    expect(expansionState()).toEqual([false, false]);

    const search = toolbar?.querySelector<HTMLInputElement>('input[type="search"]');
    if (!search) {
      throw new Error("Expected the live activity search input");
    }
    search.value = "no matching activity";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(container.querySelectorAll(".activity-entry")).toHaveLength(0);
    search.value = "m\u00fcnchen";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(container.querySelectorAll(".activity-entry")).toHaveLength(1);
    expect(container.textContent).toContain("Mu\u0308nchen output");
    search.value = "cafe\u0301";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(container.querySelectorAll(".activity-entry")).toHaveLength(1);

    const tool = container.querySelector<HTMLSelectElement>(".activity-live-filter-popover select");
    if (!tool) {
      throw new Error("Expected the live activity tool filter");
    }
    tool.value = "read";
    tool.dispatchEvent(new Event("change", { bubbles: true }));
    flush();
    expect(
      Array.from(container.querySelectorAll(".activity-entry__tool"), (entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(["read"]);
  });

  it("retains the selected tool when Live entries change", async () => {
    await i18n.setLocale("en");
    const { gateway: source, current } = activityGateway();
    const page = await bindActivity(source);
    current().testOptions.onEvent?.(toolEvent("exec", "main", "exec"));
    current().testOptions.onEvent?.(toolEvent("read"));
    await waitForSolid(() => expect(previews(page)).toEqual(["exec output", "read output"]));
    const container = page.container;
    const tool = container.querySelector<HTMLSelectElement>(".activity-live-filter-popover select");
    if (!tool) {
      throw new Error("Expected the live activity tool filter");
    }
    tool.value = "read";
    tool.dispatchEvent(new Event("change", { bubbles: true }));
    flush();
    expect(tool?.value).toBe("read");
    expect(tool?.selectedOptions[0]?.textContent).toBe("read");
    expect(
      Array.from(container.querySelectorAll(".activity-entry__tool"), (entry) =>
        entry.textContent?.trim(),
      ),
    ).toEqual(["read"]);

    container.querySelector<HTMLButtonElement>(".activity-page button.danger")?.click();
    current().testOptions.onEvent?.(toolEvent("read"));
    await waitForSolid(() => expect(previews(page)).toEqual(["read output"]));
    expect(tool?.value).toBe("read");
    expect(tool?.selectedOptions[0]?.textContent).toBe("read");
    expect(container.querySelectorAll(".activity-entry")).toHaveLength(1);

    current().testOptions.onEvent?.(toolEvent("exec", "main", "exec"));
    tool.value = "";
    tool.dispatchEvent(new Event("change", { bubbles: true }));
    await waitForSolid(() => expect(previews(page)).toEqual(["read output", "exec output"]));
    expect(tool?.value).toBe("");
    expect(tool?.selectedOptions[0]?.textContent).toBe("All tools");
    expect(container.querySelectorAll(".activity-entry")).toHaveLength(2);
  });

  it("renders selected answer candidates without tool-only facts", async () => {
    await i18n.setLocale("en");
    const { gateway: source, current } = activityGateway();
    const { container } = await bindActivity(source);
    current().testOptions.onEvent?.(
      createGatewayEvent("agent", {
        stream: "item",
        runId: "run-1",
        sessionKey: "main",
        data: {
          kind: "answer_candidate",
          itemId: "answer-1",
          status: "selected",
          progressText: "Final answer",
        },
      }),
    );
    await waitForSolid(() =>
      expect(container.querySelector(".activity-entry__tool")?.textContent?.trim()).toBe(
        "Answer candidate",
      ),
    );
    expect(container.querySelector(".activity-entry__text")?.textContent?.trim()).toBe(
      "Selected answer",
    );
    expect(container.querySelector(".activity-entry__facts")?.textContent).toContain(
      "Item: answer-1",
    );
    expect(container.querySelector(".activity-entry__facts")?.textContent).not.toContain(
      "arguments hidden",
    );
  });

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
    // A frame may arrive before the queued Live Activity publication task.
    using _ = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      queueMicrotask(() => callback(performance.now()));
      return 0;
    });
    first.current().testOptions.onEvent?.(toolEvent("old"));
    await waitForSolid(() => expect(previews(page)).toEqual(["old output"]));
    page.dispose();
    const next = activityGateway();
    const replacement = await bindActivity(next.gateway);
    await waitForSolid(() => expect(previews(replacement)).toEqual([]));
  });

  it("does not collect live events in sessions mode", async () => {
    const { gateway: source, current } = activityGateway();
    const page = await bindActivity(source);
    current().testOptions.onEvent?.(toolEvent("first"));
    await expandFirst(page);
    page.setRouteLocation({ pathname: "/activity", search: "", hash: "" });
    current().testOptions.onEvent?.(toolEvent("while-away"));
    page.setRouteLocation({ pathname: "/activity", search: "?view=live", hash: "" });
    await syncActivityRoster(page);
    await waitForSolid(() => expect(previews(page)).toEqual(["first output"]));
    expect(page.container.querySelector<HTMLDetailsElement>(".activity-entry")?.open).toBe(true);
    current().testOptions.onEvent?.(toolEvent("returned"));
    await waitForSolid(() => expect(previews(page)).toEqual(["first output", "returned output"]));
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
    current().testOptions.onEvent?.(toolEvent("old"));
    await waitForSolid(() => expect(previews(page)).toEqual(["old output"]));
    await expandFirst(page);

    current().testOptions.onClose?.({ code: 1006, reason: "reconnecting", willRetry: true });
    current().testOptions.onHello?.(activityHello("activity-owner-b"));

    await waitForSolid(() => expect(previews(page)).toEqual([]));
    expect(page.container.querySelectorAll(".activity-entry[open]")).toHaveLength(0);
    if (source.snapshot.phase !== "connected") {
      current().request.mockImplementation(async (method, params) =>
        activityResponse(method, params),
      );
      current().testOptions.onHello?.(activityHello());
    }
    await syncActivityRoster(page);
    current().testOptions.onEvent?.(toolEvent("new"));
    await waitForSolid(() => expect(previews(page)).toEqual(["new output"]));
  });

  it("keeps streamed previews and expansion across ordinary appends and reconnects", async () => {
    const { gateway: source, current } = activityGateway();
    const page = await bindActivity(source);
    current().testOptions.onEvent?.(toolEvent("first"));
    const firstRow = await expandFirst(page);

    current().testOptions.onEvent?.(toolEvent("second"));
    source.connect();
    current().testOptions.onHello?.(activityHello());

    await waitForSolid(() => expect(previews(page)).toEqual(["first output", "second output"]));
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
    const firstRow = rows()[0];
    const currentWork = () => page.container.querySelector(".activity-current-work");

    current().testOptions.onClose?.({ code: 1006, reason: "reconnecting", willRetry: true });
    flush();
    expect(rows()).toHaveLength(2);
    expect(filter.value).toBe("my draft filter");

    const failed = createDeferred<SessionsListResult>();
    current().request.mockImplementation(async (method, params) =>
      method === "sessions.list" ? failed.promise : activityResponse(method, params),
    );
    current().testOptions.onHello?.(activityHello());
    flush();
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toBe(firstRow);
    expect(currentWork()?.getAttribute("aria-busy")).toBe("true");
    expect(filter.value).toBe("my draft filter");
    failed.reject(new Error("Current Work refresh unavailable"));
    const retry = () =>
      page.container.querySelector<HTMLButtonElement>(".activity-current-work__feedback button");
    await waitForSolid(() => expect(retry()?.textContent?.trim()).toBe("Retry"));
    expect(page.container.querySelector(".activity-current-work__feedback")?.textContent).toContain(
      "Could not load active sessions",
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
    expect(filter.value).toBe("my draft filter");
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
      } else {
        current().testOptions.onEvent?.(toolEvent("previous-account"));
        await waitForSolid(() => expect(previews(page)).toEqual(["previous-account output"]));
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
      await waitForSolid(() => expect(previews(page)).toEqual([]));
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
          current().testOptions.onEvent?.(toolEvent("new-context"));
        }
      });
      try {
        const page = await bindActivity(source);
        current().testOptions.onEvent?.(toolEvent("old"));
        retiring = true;

        source.connect({ gatewayUrl: "wss://other-activity.example.test" });

        await waitForSolid(() => expect(previews(page)).toEqual([]));
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
    current().testOptions.onEvent?.(toolEvent("before-open"));
    const firstPage = await bindActivity(source);
    await waitForSolid(() => expect(previews(firstPage)).toEqual([]));
    current().testOptions.onEvent?.(toolEvent("first-visit"));
    await waitForSolid(() => expect(previews(firstPage)).toEqual(["first-visit output"]));
    expect(source.eventLog).toEqual([]);
    firstPage.dispose();

    current().testOptions.onEvent?.(toolEvent("while-away"));
    const nextPage = await bindActivity(source);
    await waitForSolid(() => expect(previews(nextPage)).toEqual([]));
    current().testOptions.onEvent?.(toolEvent("next-visit"));
    await waitForSolid(() => expect(previews(nextPage)).toEqual(["next-visit output"]));
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
      current().testOptions.onEvent?.(
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

    await waitForSolid(() =>
      expect(
        [...page.container.querySelectorAll<HTMLAnchorElement>(".activity-entry__run-link")].map(
          (link) => new URL(link.href).searchParams.get("run"),
        ),
      ).toEqual(["selected", "other", "global", "unknown"]),
    );
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
    current().testOptions.onEvent?.(toolEvent("hidden"));
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

    await waitForSolid(() => expect(previews(page)).toEqual([]));
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
    current().testOptions.onEvent?.(toolEvent("visible"));
    await waitForSolid(() => expect(previews(page)).toEqual(["visible output"]));
    page.dispose();
    current().testOptions.onEvent?.(toolEvent("unmounted"));
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
    current().testOptions.onEvent?.(toolEvent("recovered"));
    await waitForSolid(() => expect(previews(page)).toEqual(["recovered output"]));

    expect(container.querySelector('[role="alert"]')).toBeNull();
    await sessions.unsubscribeMessages(recovered);
  });

  it("preserves activity and Clear when the selected chat changes", async () => {
    const { gateway: source, current } = activityGateway();
    const page = await bindActivity(source);
    current().testOptions.onEvent?.(toolEvent("original"));
    const originalRow = await expandFirst(page);
    source.setSessionKey("agent:other:work");

    await waitForSolid(() => expect(previews(page)).toEqual(["original output"]));
    expect(originalRow.open).toBe(true);
    expect(page.container.querySelector(".activity-entry")).toBe(originalRow);
    current().testOptions.onEvent?.(toolEvent("other", "agent:other:work"));
    await waitForSolid(() => expect(previews(page)).toEqual(["original output", "other output"]));

    const container = page.container;
    const clear = container.querySelector<HTMLButtonElement>(".activity-page button.danger");
    expect(clear?.textContent?.trim()).toBe("Clear");
    clear?.click();
    source.setSessionKey("main");
    await waitForSolid(() => expect(previews(page)).toEqual([]));
    current().testOptions.onEvent?.(toolEvent("after-clear", "agent:other:work"));
    await waitForSolid(() => expect(previews(page)).toEqual(["after-clear output"]));
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
