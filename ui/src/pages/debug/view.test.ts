import { getQueriesForElement } from "@solidjs/testing-library";
import hljs from "highlight.js/lib/core";
import { createComponent, flush } from "solid-js";
import { afterEach, assert, expect, it, vi } from "vitest";
import { flattenTranslations } from "../../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { EventLogEntry } from "../../api/event-log.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { zh_CN } from "../../i18n/locales/zh-CN.ts";
import type { CommandLaneDiagnostics } from "../../lib/gateway-diagnostics.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { DebugPage } from "./debug-page.tsx";
import {
  createDebugApplicationContext,
  diagnosticResponse,
  normalizedText,
  useDebugTestEnvironment,
} from "./debug.test-support.ts";

function mountDebugHost(context: ApplicationContext) {
  const provider = createSolidApplicationContextProvider(context);
  const mounted = mountSolid(() => createComponent(DebugPage, {}), {
    wrapper: provider.wrapper,
  });
  flush();
  return Object.assign(mounted.container, {
    unmount: mounted.unmount,
    setContext: provider.setContext,
  });
}

function readSnapshot(page: HTMLElement, title: string): unknown {
  const block = page.querySelector(`pre[aria-label="${title}"]`);
  assert(block);
  return JSON.parse(block.textContent ?? "null");
}

function callMethod(page: HTMLElement, method: string): void {
  const select = page.querySelector<HTMLSelectElement>('select[aria-label="Method"]');
  assert(select);
  select.value = method;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  flush();
  const call = page.querySelector<HTMLButtonElement>("button.primary");
  assert(call);
  call.click();
  flush();
}

async function mountDebugPage(
  request: (method: string) => Promise<unknown>,
  context = createDebugApplicationContext(request),
) {
  const page = mountDebugHost(context);
  flush();
  await waitForSolid(() => expect(readSnapshot(page, "Status")).toEqual({ version: "initial" }));
  return page;
}

const snapshotTitles = ["Status", "Health", "Models", "Last heartbeat"];
function readSnapshots(page: HTMLElement) {
  return snapshotTitles.map((title) => readSnapshot(page, title));
}
function expectSnapshots(page: HTMLElement, marker: string, liveMarker = marker): void {
  expect(readSnapshots(page)).toEqual([
    { version: marker },
    { marker, ok: true },
    [{ id: marker }],
    { source: liveMarker },
  ]);
  expect(normalizedText(page.querySelector(".command-lane-row"))).toContain(liveMarker);
}

function gatewaySource(context: ApplicationContext) {
  const source = createApplicationGateway(context.gateway.snapshot);
  Object.assign(source.gateway, { eventLog: [], subscribeEventLog: () => () => undefined });
  return source;
}

const refreshButton = (page: HTMLElement) =>
  page.querySelector<HTMLButtonElement>(".settings-section button")!;
const snapshotAlert = (page: HTMLElement) =>
  page.querySelector<HTMLElement>('.settings-section:first-child [role="alert"]');

function diagnosticRequest(overrides: Record<string, () => unknown>) {
  return vi.fn(async (method: string) => {
    const override = overrides[method];
    return override ? override() : diagnosticResponse(method);
  });
}

type PresentationResponses = {
  status: Record<string, unknown> | null;
  health: Record<string, unknown> | null;
  "models.list": { models: unknown[] };
  "last-heartbeat": unknown;
  "diagnostics.lanes": CommandLaneDiagnostics;
};

async function mountDebugPresentation(initial: Partial<PresentationResponses> = {}) {
  const responses: Record<string, unknown> = { ...initial };
  let events: readonly EventLogEntry[] = [];
  const eventListeners = new Set<(events: readonly EventLogEntry[]) => void>();
  const context = createDebugApplicationContext(async (method) => {
    return Object.hasOwn(responses, method) ? responses[method] : diagnosticResponse(method);
  });
  const page = mountDebugHost({
    ...context,
    gateway: {
      ...context.gateway,
      get eventLog() {
        return events;
      },
      subscribeEventLog(listener) {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
    },
  });
  const waitForDiagnostics = () =>
    waitForSolid(() => expect(refreshButton(page).disabled).toBe(false));
  await waitForDiagnostics();
  return {
    page,
    setEvents(this: void, next: readonly EventLogEntry[]) {
      events = next;
      eventListeners.forEach((listener) => listener(events));
      flush();
    },
    async refresh(this: void, next: Partial<PresentationResponses>) {
      Object.assign(responses, next);
      refreshButton(page).click();
      await waitForDiagnostics();
    },
    async call(this: void, result: unknown) {
      responses["manual.latest"] = result;
      callMethod(page, "manual.latest");
      await waitForSolid(() =>
        expect(page.querySelector('pre[aria-label="manual.latest: OK"]')?.textContent).toBe(
          JSON.stringify(result, null, 2),
        ),
      );
    },
  };
}

useDebugTestEnvironment();
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("names the page with a level-one heading", async () => {
  const page = await mountDebugPage(diagnosticRequest({}));
  expect(getQueriesForElement(page).getByRole("heading", { level: 1 }).textContent).toBe("Debug");
});

it("only highlights changed diagnostics and tolerates out-of-range event timestamps", async () => {
  const { page, setEvents, refresh, call } = await mountDebugPresentation();
  const event = (message: string, ts = 1) => ({ ts, event: "agent", payload: { message } });
  const events = [event("retained"), event("evicted")];
  const highlight = vi.spyOn(hljs, "highlight");
  setEvents(events);
  await call({ ok: true });
  const eventSection = page.querySelector(".settings-section:last-child");
  assert(eventSection);
  await waitForSolid(() => expect(eventSection.querySelector("pre span")).not.toBeNull());
  highlight.mockClear();

  const newest = { ...event("newest", 8_640_000_000_000_001), event: "gateway" };
  setEvents([newest, ...events.slice(0, -1)]);
  flush();

  expect(page.textContent).toContain("gateway");
  expect(page.textContent).not.toContain("Invalid Date");
  expect(highlight).toHaveBeenCalledTimes(1);

  highlight.mockClear();
  const input = page.querySelector("textarea");
  assert(input);
  input.value = '{"typed":true}';
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(highlight).not.toHaveBeenCalled();

  await refresh({
    status: { version: "updated" },
    health: { ok: true },
    "last-heartbeat": { source: "updated" },
    "models.list": { models: [{ id: "updated" }] },
  });
  await call({ result: "updated" });
  expect(highlight).toHaveBeenCalledTimes(5);
  expect(page.textContent).toContain("updated");
  setEvents([]);
  expect(eventSection.querySelector("pre")).toBeNull();
  expect(eventSection.textContent).not.toContain("retained");
});

it("updates security audit labels with the locale and keeps the command monospace", async () => {
  const { page } = await mountDebugPresentation({
    status: { securityAudit: { summary: { critical: 0, warn: 1, info: 2 } } },
  });

  expect(page.querySelector(".settings-status")?.textContent).toContain("1 warning");
  await i18n.setLocale("zh-CN");
  flush();

  const command = page.querySelector<HTMLElement>(".settings-row__desc .mono");
  assert(command, "expected debug security audit command");
  const status = page.querySelector(".settings-status");
  const chinese = flattenTranslations(zh_CN);
  expect(status?.className).toContain("settings-status--warn");
  expect(normalizedText(status)).toBe(
    [
      chinese.get("debug.security.warnings")?.replace("{count}", "1"),
      chinese.get("debug.security.info")?.replace("{count}", "2"),
    ].join(" · "),
  );
  expect(command.textContent).toBe("openclaw security audit --deep");
});

it.each(["global", "per-session"] as const)(
  "renders %s lane capacity and saturation",
  async (scope) => {
    const perSession = scope === "per-session";
    const lane: CommandLaneDiagnostics["lanes"][number] = {
      lane: perSession ? "subagent" : "main",
      activeCount: perSession ? 16 : 2,
      queuedCount: perSession ? 0 : 3,
      maxConcurrent: perSession ? 8 : 2,
      draining: false,
      generation: 0,
      concurrencyScope: perSession ? "session" : undefined,
      saturatedLaneCount: perSession ? 0 : undefined,
      group: perSession ? undefined : "interactive",
      groupActive: perSession ? undefined : 2,
      groupBudget: perSession ? undefined : 4,
      blockedBy: perSession ? undefined : "lane",
    };
    const dynamic = perSession
      ? null
      : { laneCount: 23, activeCount: 9, queuedCount: 4, queuedLaneCount: 3 };
    const { page, refresh } = await mountDebugPresentation({
      "diagnostics.lanes": { lanes: [lane], dynamic },
    });
    const row = page.querySelector(".command-lane-row");
    expect([
      row?.classList.contains("command-lane-row--saturated"),
      row?.classList.contains("command-lane-row--queued"),
    ]).toEqual([!perSession, !perSession]);
    expect(normalizedText(row)).toContain(
      perSession ? "subagent 16 · 8/session 0" : "main 2/2 3 interactive · 2/4 lane",
    );
    if (dynamic) {
      expect(normalizedText(page.querySelector(".command-lane-row--dynamic"))).toContain(
        "Session lanes · 23 9 4 —",
      );
    } else {
      await refresh({
        "diagnostics.lanes": { lanes: [{ ...lane, saturatedLaneCount: 1 }], dynamic },
      });
      expect(page.querySelector(".command-lane-row")?.classList).toContain(
        "command-lane-row--saturated",
      );
    }
  },
);
it.each(["reconnect", "source", "agent", "agent with failed models"] as const)(
  "retires a pending live poll and refreshes snapshots after a %s change",
  async (change) => {
    vi.useFakeTimers();
    const pending = deferred();
    const pendingModels = deferred<unknown>();
    const failedAgentSwitch = change === "agent with failed models";
    let marker = "initial";
    let holdLive = false;
    let holdModels = false;
    const request = vi.fn(
      async (method: string, _params?: unknown, _options?: { signal?: AbortSignal }) => {
        if (holdModels && method === "models.list") {
          return pendingModels.promise;
        }
        if (holdLive && (method === "last-heartbeat" || method === "diagnostics.lanes")) {
          await pending.promise;
          return diagnosticResponse(method, "stale");
        }
        return diagnosticResponse(method, marker);
      },
    );
    const context = createDebugApplicationContext(request);
    const source = gatewaySource(context);
    const selection = createAgentSelectionCapability(
      source.gateway,
      { state: { agentsList: null }, subscribe: () => () => undefined },
      { load: () => "main", save: () => undefined },
    );
    const pageContext = {
      ...context,
      gateway: source.gateway,
      settingsAgentSelection: selection,
    };
    const page = mountDebugHost(pageContext);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expectSnapshots(page, "initial");
      holdLive = true;
      await vi.advanceTimersByTimeAsync(3_000);
      const heldCalls = request.mock.calls.slice(-2);
      const heldCount = request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(6_000);
      expect(request).toHaveBeenCalledTimes(heldCount);
      marker = "current";
      holdLive = false;
      holdModels = failedAgentSwitch;
      if (change === "reconnect") {
        source.publish({ ...source.gateway.snapshot, phase: "reconnecting" });
        source.publish({ ...source.gateway.snapshot, phase: "connected" });
      } else if (change === "source") {
        const replacement = gatewaySource({ ...context, gateway: source.gateway });
        page.setContext({ ...pageContext, gateway: replacement.gateway });
      } else {
        selection.set("worker");
      }
      flush();
      if (failedAgentSwitch) {
        expect(readSnapshot(page, "Models")).toEqual([]);
        pendingModels.reject(new Error("worker models unavailable"));
      }
      await vi.advanceTimersByTimeAsync(0);
      if (failedAgentSwitch) {
        expect(readSnapshot(page, "Models")).toEqual([]);
        expect(page.textContent).toContain("worker models unavailable");
      } else {
        expectSnapshots(page, "current");
      }
      for (const call of heldCalls) {
        expect(call[2]?.signal?.aborted).toBe(true);
      }
      pending.resolve();
      await vi.advanceTimersByTimeAsync(0);
      if (failedAgentSwitch) {
        expect(readSnapshot(page, "Models")).toEqual([]);
        expect(page.textContent).not.toContain("stale");
      } else {
        expectSnapshots(page, "current");
      }
      expect(request.mock.calls.filter(([method]) => method === "status")).toHaveLength(2);
      const count = request.mock.calls.length;
      page.unmount();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(request).toHaveBeenCalledTimes(count);
    } finally {
      pending.resolve();
      pendingModels.resolve({ models: [] });
      page.unmount();
      selection.dispose();
    }
  },
);

it("discards pending diagnostics when a replacement provider reuses its client", async () => {
  const pending = deferred<unknown>();
  const request = vi.fn(() => pending.promise);
  const context = createDebugApplicationContext(request);
  const page = mountDebugHost(context);
  expect(request).toHaveBeenCalledTimes(5);
  page.setContext({
    ...context,
    gateway: { ...context.gateway, snapshot: { ...context.gateway.snapshot, phase: "stopped" } },
  });
  flush();
  pending.resolve({ models: [{ id: "stale" }], stale: true });
  await pending.promise;
  flush();
  expect(request).toHaveBeenCalledTimes(5);
  expect(readSnapshots(page)).toEqual([{}, {}, [], {}]);
  expect(page.querySelector(".command-lane-row")).toBeNull();
  expect(page.textContent).not.toContain("stale");
});

it("polls live lanes and heartbeat while full snapshots change only on Refresh", async () => {
  vi.useFakeTimers();
  let marker = "initial";
  const pendingRefresh = deferred();
  const request = vi.fn(async (method: string) => {
    if (marker === "manual") {
      await pendingRefresh.promise;
    }
    return diagnosticResponse(method, marker);
  });
  const page = await mountDebugPage(request);
  try {
    marker = "live";
    await vi.advanceTimersByTimeAsync(9_000);
    flush();
    for (const method of ["status", "health", "models.list"]) {
      expect(request.mock.calls.filter(([called]) => called === method)).toHaveLength(1);
    }
    expectSnapshots(page, "initial", "live");
    marker = "manual";
    const refresh = refreshButton(page);
    refresh.click();
    flush();
    expect(refresh.disabled).toBe(true);
    expect(normalizedText(refresh)).toBe("Refreshing…");
    expect(page.querySelector(".settings-section .settings-status")).toBeNull();
    expect(page.textContent).toContain("initial");
    pendingRefresh.resolve();
    await vi.advanceTimersByTimeAsync(0);
    flush();
    expectSnapshots(page, "manual");
    for (const method of ["status", "health", "models.list"]) {
      expect(request.mock.calls.filter(([called]) => called === method)).toHaveLength(2);
    }
  } finally {
    pendingRefresh.resolve();
    page.unmount();
  }
});

it("keeps a held live poll quiet and recovers its error without replacing snapshots or drafts", async () => {
  vi.useFakeTimers();
  const held = deferred();
  let pollState: "initial" | "held" | "recovered" = "initial";
  const request = vi.fn(async (method: string) => {
    if (method === "last-heartbeat" || method === "diagnostics.lanes") {
      if (pollState === "held") {
        await held.promise;
        throw new Error("live diagnostics unavailable");
      }
      return diagnosticResponse(method, pollState);
    }
    return diagnosticResponse(method);
  });
  const page = await mountDebugPage(request);
  try {
    const params = page.querySelector<HTMLTextAreaElement>("textarea")!;
    params.value = '{"draft":true}';
    params.dispatchEvent(new Event("input", { bubbles: true }));
    params.focus();
    flush();
    const status = page.querySelector('pre[aria-label="Status"]');
    pollState = "held";
    await vi.advanceTimersByTimeAsync(3_000);
    expect(refreshButton(page).disabled).toBe(false);
    expect(normalizedText(refreshButton(page))).toBe("Refresh");
    expectSnapshots(page, "initial");
    held.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshotAlert(page)?.textContent).toContain("live diagnostics unavailable");
    expectSnapshots(page, "initial");
    pollState = "recovered";
    await vi.advanceTimersByTimeAsync(3_000);
    expect(snapshotAlert(page)).toBeNull();
    expectSnapshots(page, "initial", "recovered");
    expect(page.querySelector('pre[aria-label="Status"]')).toBe(status);
    expect(page.querySelector("textarea")).toBe(params);
    expect(params.value).toBe('{"draft":true}');
    expect(document.activeElement).toBe(params);
    expect(request.mock.calls.filter(([method]) => method === "status")).toHaveLength(1);
  } finally {
    held.resolve();
    page.unmount();
  }
});

it.each(["reconnecting", "offline"] as const)(
  "disables refresh while %s, labeling only stable outages offline",
  async (phase) => {
    const request = vi.fn(async (method: string) => diagnosticResponse(method));
    const page = mountDebugHost(createDebugApplicationContext(request, phase));
    flush();
    expect(page.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    const text = normalizedText(page.querySelector(".settings-section"));
    if (phase === "offline") {
      expect(text).toContain("Offline");
      expect(text).toContain("Connect to the Gateway to refresh diagnostics.");
    } else {
      expect(text).not.toContain("Offline");
    }
  },
);

it.each(["response", "error"])(
  "ignores an older manual RPC %s after the latest call succeeds",
  async (outcome) => {
    const older = deferred<unknown>();
    const request = diagnosticRequest({
      "manual.first": () => older.promise,
      "manual.latest": () => ({ result: "latest response" }),
    });
    const page = await mountDebugPage(request);

    callMethod(page, "manual.first");
    expect(request).toHaveBeenCalledWith("manual.first", {});
    const olderRequest = request.mock.results.at(-1)!.value;
    callMethod(page, "manual.latest");
    await waitForSolid(() => expect(page.textContent).toContain("latest response"));
    if (outcome === "error") {
      older.reject(new Error("stale manual failure"));
    } else {
      older.resolve({ result: "stale response" });
    }
    await olderRequest.catch(() => undefined);
    flush();

    expect(page.textContent).toContain("latest response");
    expect(page.textContent).not.toContain("stale response");
    expect(page.querySelector('[role="alert"]')).toBeNull();
  },
);

it.each(["success", "error"] as const)(
  "clears completed manual RPC %s when the Gateway client changes in place",
  async (outcome) => {
    const expected = outcome === "error" ? "previous client failure" : "previous client response";
    const request = diagnosticRequest({
      "manual.latest": () => {
        if (outcome === "error") {
          throw new Error(expected);
        }
        return { result: expected };
      },
    });
    const initial = createDebugApplicationContext(request);
    const source = gatewaySource(initial);
    const context = { ...initial, gateway: source.gateway };
    const page = await mountDebugPage(request, context);
    const rpcSection = page.querySelector("select")?.closest(".settings-section");
    assert(rpcSection);

    callMethod(page, "manual.latest");
    await waitForSolid(() => expect(rpcSection.textContent).toContain(expected));
    expect(rpcSection.querySelector("pre")).not.toBeNull();

    const replacement = createDebugApplicationContext(async (method) =>
      diagnosticResponse(method, "replacement"),
    );
    source.publish({
      ...source.gateway.snapshot,
      client: replacement.gateway.snapshot.client,
    });
    flush();
    expect(rpcSection.querySelector("pre")).toBeNull();
    await waitForSolid(() => expectSnapshots(page, "replacement"));
    expect(rpcSection.querySelector("pre")).toBeNull();
  },
);

it("preserves snapshots and independent Manual RPC errors through model failure and recovery", async () => {
  const failedMethod = "models.list";
  vi.useFakeTimers();
  let failure: typeof failedMethod | null = null;
  let marker = "initial";
  const request = vi.fn(async (method: string) => {
    if (method === "manual.latest") {
      throw new Error("manual request failed");
    }
    if (method === failure) {
      throw new Error(`${method} unavailable`);
    }
    return diagnosticResponse(method, marker);
  });
  const page = await mountDebugPage(request);
  expectSnapshots(page, "initial");
  callMethod(page, "manual.latest");
  await waitForSolid(() => expect(page.textContent).toContain("manual request failed"));
  expect(snapshotAlert(page)).toBeNull();

  marker = "uncommitted";
  failure = failedMethod;
  refreshButton(page).click();
  await waitForSolid(() => expect(page.textContent).toContain(`${failedMethod} unavailable`));

  expect(page.textContent).toContain("manual request failed");
  expectSnapshots(page, "initial");
  const alert = snapshotAlert(page);
  expect(alert?.closest(".settings-section")?.querySelector("h2")?.textContent.trim()).toBe(
    "Snapshots",
  );
  expect(alert?.classList).toContain("settings-row");
  expect(page.querySelector(".callout")).toBeNull();

  marker = "recovered";
  failure = null;
  refreshButton(page).click();
  await waitForSolid(() => expectSnapshots(page, "recovered"));

  expect(snapshotAlert(page)).toBeNull();
  expect(page.textContent).toContain("manual request failed");
});
