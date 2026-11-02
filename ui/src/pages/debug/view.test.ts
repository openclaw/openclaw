import { getQueriesForElement } from "@solidjs/testing-library";
import { createComponent, flush } from "solid-js";
import { afterEach, assert, expect, it, onTestFinished, vi } from "vitest";
import { flattenTranslations } from "../../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { EventLogEntry } from "../../api/event-log.ts";
import { createAgentSelectionCapability } from "../../app/agent-selection.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
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

useDebugTestEnvironment();
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function gatewaySource(context: ApplicationContext) {
  const source = createApplicationGateway(context.gateway.snapshot);
  Object.assign(source.gateway, { eventLog: [], subscribeEventLog: () => () => undefined });
  return source;
}
function hold<T>(fallback: T) {
  const pending = deferred<T>();
  onTestFinished(() => pending.resolve(fallback));
  return pending;
}
async function tick(ms = 0) {
  await vi.advanceTimersByTimeAsync(ms);
  flush();
}

function mountPage(
  responses: Record<string, () => unknown> = {},
  phase: ApplicationGatewaySnapshot["phase"] = "connected",
  events: readonly EventLogEntry[] = [],
) {
  let marker = "initial";
  const request = vi.fn(
    async (method: string, _params?: unknown, _options?: { signal?: AbortSignal }) =>
      responses[method] ? responses[method]() : diagnosticResponse(method, marker),
  );
  const initial = createDebugApplicationContext(request, phase);
  const source = gatewaySource(initial);
  Object.assign(source.gateway, { eventLog: events });
  const selection = createAgentSelectionCapability(
    source.gateway,
    { state: { agentsList: null }, subscribe: () => () => undefined },
    { load: () => "main", save: () => undefined },
  );
  const context = { ...initial, gateway: source.gateway, settingsAgentSelection: selection };
  const provider = createSolidApplicationContextProvider(context);
  const mounted = mountSolid(() => createComponent(DebugPage, {}), { wrapper: provider.wrapper });
  onTestFinished(() => selection.dispose());
  const page = mounted.container;
  const query = (selector: string) => page.querySelector<HTMLElement>(selector);
  const refreshButton = () => page.querySelector<HTMLButtonElement>(".settings-section button")!;
  const snapshot = (title: string) => {
    const block = query(`pre[aria-label="${title}"]`);
    assert(block);
    return JSON.parse(block.textContent ?? "null");
  };
  const ready = () => waitForSolid(() => expect(refreshButton().disabled).toBe(false));
  flush();
  return {
    ...mounted,
    page,
    query,
    source,
    context,
    request,
    responses,
    selection,
    snapshot,
    ready,
    setContext: provider.setContext,
    refreshButton,
    alert: () => query('.settings-section:first-child [role="alert"]'),
    mark: (value: string) => {
      marker = value;
    },
    snapshots(expected: string, live = expected) {
      expect(["Status", "Health", "Models", "Last heartbeat"].map(snapshot)).toEqual([
        { version: expected },
        { marker: expected, ok: true },
        [{ id: expected }],
        { source: live },
      ]);
      expect(normalizedText(query(".command-lane-row"))).toContain(live);
    },
    params(value: string) {
      const input = page.querySelector("textarea")!;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
      return input;
    },
    call(method = "manual.latest") {
      const select = page.querySelector<HTMLSelectElement>('select[aria-label="Method"]')!;
      select.value = method;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      flush();
      page.querySelector<HTMLButtonElement>("button.primary")!.click();
      flush();
    },
    async refresh() {
      refreshButton().click();
      await ready();
    },
  };
}

it("names the page with a level-one heading", async () => {
  const h = mountPage();
  await h.ready();
  expect(getQueriesForElement(h.page).getByRole("heading", { level: 1 }).textContent).toBe("Debug");
});

it("tolerates out-of-range event timestamps", async () => {
  const h = mountPage({}, "connected", [
    { ts: 8_640_000_000_000_001, event: "gateway", payload: { message: "newest" } },
  ]);
  await h.ready();
  await waitForSolid(() => expect(h.query(".settings-section:last-child pre span")).not.toBeNull());
  expect(h.page.textContent).toContain("gateway");
  expect(h.page.textContent).not.toContain("Invalid Date");
});

it("keeps the security row present while snapshots load and Manual RPC remains available", async () => {
  const status = hold<unknown>({});
  const h = mountPage({ status: () => status.promise });
  await waitForSolid(() =>
    expect(h.query(".debug-security-status")?.textContent).toContain("Loading"),
  );
  const row = h.query(".debug-security-status")?.closest(".settings-row");
  expect(row?.textContent).toContain("openclaw security audit --deep");
  expect(h.page.querySelector('select[aria-label="Method"]')).not.toBeNull();
  status.resolve({ securityAudit: { summary: { critical: 0, warn: 0, info: 0 } } });
  await h.ready();
  expect(h.query(".debug-security-status")?.closest(".settings-row")).toBe(row);
  expect(row?.textContent).toContain("No critical issues");
});

it("updates security audit labels with the locale and keeps the command monospace", async () => {
  const h = mountPage({
    status: () => ({ securityAudit: { summary: { critical: 0, warn: 1, info: 2 } } }),
  });
  await h.ready();
  expect(h.query(".settings-status")?.textContent).toContain("1 warning");
  await i18n.setLocale("zh-CN");
  flush();
  const chinese = flattenTranslations(zh_CN);
  expect(h.query(".settings-status")?.className).toContain("settings-status--warn");
  expect(normalizedText(h.query(".settings-status"))).toBe(
    [
      chinese.get("debug.security.warnings")?.replace("{count}", "1"),
      chinese.get("debug.security.info")?.replace("{count}", "2"),
    ].join(" · "),
  );
  expect(h.query(".settings-row__desc .mono")?.textContent).toBe("openclaw security audit --deep");
});

it.each(["global", "per-session"] as const)(
  "renders %s lane capacity and saturation",
  async (scope) => {
    const perSession = scope === "per-session";
    let lane: CommandLaneDiagnostics["lanes"][number] = {
      lane: perSession ? "subagent" : "main",
      activeCount: perSession ? 16 : 2,
      queuedCount: perSession ? 0 : 3,
      maxConcurrent: perSession ? 8 : 2,
      draining: false,
      generation: 0,
      ...(perSession
        ? { concurrencyScope: "session", saturatedLaneCount: 0 }
        : {
            group: "interactive",
            groupActive: 2,
            groupBudget: 4,
            blockedBy: "lane",
          }),
    };
    const dynamic = perSession
      ? null
      : { laneCount: 23, activeCount: 9, queuedCount: 4, queuedLaneCount: 3 };
    const h = mountPage({ "diagnostics.lanes": () => ({ lanes: [lane], dynamic }) });
    await h.ready();
    const row = h.query(".command-lane-row");
    expect([
      row?.classList.contains("command-lane-row--saturated"),
      row?.classList.contains("command-lane-row--queued"),
    ]).toEqual([!perSession, !perSession]);
    expect(normalizedText(row)).toContain(
      perSession ? "subagent 16 · 8/session 0" : "main 2/2 3 interactive · 2/4 lane",
    );
    if (dynamic) {
      expect(normalizedText(h.query(".command-lane-row--dynamic"))).toContain(
        "Session lanes · 23 9 4 —",
      );
    } else {
      lane = { ...lane, saturatedLaneCount: 1 };
      await h.refresh();
      expect(h.query(".command-lane-row")?.classList).toContain("command-lane-row--saturated");
    }
  },
);

it.each(["reconnect", "source", "agent", "agent with failed models"] as const)(
  "retires a pending live poll and refreshes snapshots after a %s change",
  async (change) => {
    vi.useFakeTimers();
    const pending = hold<void>(undefined);
    const pendingModels = hold<unknown>({ models: [] });
    const h = mountPage();
    await tick();
    h.snapshots("initial");
    for (const method of ["last-heartbeat", "diagnostics.lanes"]) {
      h.responses[method] = async () => {
        await pending.promise;
        return diagnosticResponse(method, "stale");
      };
    }
    await tick(3_000);
    const heldCalls = h.request.mock.calls.slice(-2);
    const heldCount = h.request.mock.calls.length;
    await tick(6_000);
    expect(h.request).toHaveBeenCalledTimes(heldCount);
    delete h.responses["last-heartbeat"];
    delete h.responses["diagnostics.lanes"];
    h.mark("current");
    const failed = change === "agent with failed models";
    if (failed) {
      h.responses["models.list"] = () => pendingModels.promise;
    }
    if (change === "reconnect") {
      h.source.publish({ ...h.source.gateway.snapshot, phase: "reconnecting" });
      h.source.publish({ ...h.source.gateway.snapshot, phase: "connected" });
    } else if (change === "source") {
      h.setContext({ ...h.context, gateway: gatewaySource(h.context).gateway });
    } else {
      h.selection.set("worker");
    }
    flush();
    if (failed) {
      expect(h.snapshot("Models")).toEqual([]);
      pendingModels.reject(new Error("worker models unavailable"));
    }
    const expectCurrent = () => {
      if (!failed) {
        h.snapshots("current");
        return;
      }
      expect(h.snapshot("Models")).toEqual([]);
      expect(h.page.textContent).toContain("worker models unavailable");
      expect(h.page.textContent).not.toContain("stale");
    };
    await tick();
    expectCurrent();
    for (const call of heldCalls) {
      expect(call[2]?.signal?.aborted).toBe(true);
    }
    pending.resolve();
    await tick();
    expectCurrent();
    const count = h.request.mock.calls.length;
    h.unmount();
    await tick(6_000);
    expect(h.request).toHaveBeenCalledTimes(count);
  },
);

it("discards pending diagnostics when a replacement provider reuses its client", async () => {
  const pending = hold<unknown>({});
  const h = mountPage(
    Object.fromEntries(
      ["status", "health", "models.list", "last-heartbeat", "diagnostics.lanes"].map(
        (method): [string, () => unknown] => [method, () => pending.promise],
      ),
    ),
  );
  expect(h.request).toHaveBeenCalledTimes(5);
  h.setContext({
    ...h.context,
    gateway: { ...h.source.gateway, snapshot: { ...h.source.gateway.snapshot, phase: "stopped" } },
  });
  flush();
  pending.resolve({ models: [{ id: "stale" }], stale: true });
  await pending.promise;
  flush();
  expect(h.request).toHaveBeenCalledTimes(5);
  expect(["Status", "Health", "Models", "Last heartbeat"].map(h.snapshot)).toEqual([
    {},
    {},
    [],
    {},
  ]);
  expect(h.query(".command-lane-row")).toBeNull();
  expect(h.page.textContent).not.toContain("stale");
});

it("keeps a held live poll quiet and recovers without replacing snapshots or drafts", async () => {
  vi.useFakeTimers();
  const pending = hold<void>(undefined);
  const h = mountPage();
  await tick();
  const params = h.params('{"draft":true}');
  params.focus();
  const status = h.query('pre[aria-label="Status"]');
  for (const method of ["last-heartbeat", "diagnostics.lanes"]) {
    h.responses[method] = async () => {
      await pending.promise;
      throw new Error("live diagnostics unavailable");
    };
  }
  await tick(3_000);
  expect(h.refreshButton().disabled).toBe(false);
  expect(normalizedText(h.refreshButton())).toBe("Refresh");
  h.snapshots("initial");
  pending.resolve();
  await tick();
  expect(h.alert()?.textContent).toContain("live diagnostics unavailable");
  h.snapshots("initial");
  delete h.responses["last-heartbeat"];
  delete h.responses["diagnostics.lanes"];
  h.mark("recovered");
  await tick(3_000);
  expect(h.alert()).toBeNull();
  h.snapshots("initial", "recovered");
  expect(h.query('pre[aria-label="Status"]')).toBe(status);
  expect(h.query("textarea")).toBe(params);
  expect(params.value).toBe('{"draft":true}');
  expect(document.activeElement).toBe(params);
});

it.each(["reconnecting", "offline"] as const)("disables refresh while %s", async (phase) => {
  const h = mountPage({}, phase);
  expect(h.refreshButton().disabled).toBe(true);
  const text = normalizedText(h.query(".settings-section"));
  if (phase === "offline") {
    expect(text).toContain("Offline");
    expect(text).toContain("Connect to the Gateway to refresh diagnostics.");
  } else {
    expect(text).not.toContain("Offline");
  }
});

it.each(["response", "error"])("ignores an older manual RPC %s", async (outcome) => {
  const older = hold<unknown>({});
  const h = mountPage({
    "manual.first": () => older.promise,
    "manual.latest": () => ({ result: "latest response" }),
  });
  await h.ready();
  h.call("manual.first");
  const olderRequest = h.request.mock.results.at(-1)!.value;
  h.call();
  await waitForSolid(() => expect(h.page.textContent).toContain("latest response"));
  if (outcome === "error") {
    older.reject(new Error("stale manual failure"));
  } else {
    older.resolve({ result: "stale response" });
  }
  await olderRequest.catch(() => undefined);
  flush();
  expect(h.page.textContent).toContain("latest response");
  expect(h.page.textContent).not.toContain("stale response");
  expect(h.query('[role="alert"]')).toBeNull();
});

it.each(["success", "error"] as const)(
  "clears completed manual RPC %s on client change",
  async (outcome) => {
    const expected = `previous client ${outcome}`;
    const h = mountPage({
      "manual.latest": () => {
        if (outcome === "error") {
          throw new Error(expected);
        }
        return { result: expected };
      },
    });
    await h.ready();
    const section = h.query("select")!.closest(".settings-section")!;
    h.call();
    await waitForSolid(() => expect(section.textContent).toContain(expected));
    expect(section.querySelector("pre")).not.toBeNull();
    h.mark("replacement");
    h.source.publish({
      ...h.source.gateway.snapshot,
      client: createDebugApplicationContext(h.request).gateway.snapshot.client,
    });
    flush();
    expect(section.querySelector("pre")).toBeNull();
    await waitForSolid(() => h.snapshots("replacement"));
    expect(section.querySelector("pre")).toBeNull();
  },
);

it("preserves snapshots and independent RPC errors through model failure and recovery", async () => {
  vi.useFakeTimers();
  const h = mountPage({
    "manual.latest": () => {
      throw new Error("manual request failed");
    },
  });
  await h.ready();
  h.snapshots("initial");
  h.call();
  await waitForSolid(() => expect(h.page.textContent).toContain("manual request failed"));
  expect(h.alert()).toBeNull();
  h.mark("uncommitted");
  h.responses["models.list"] = () => {
    throw new Error("models.list unavailable");
  };
  await h.refresh();
  expect(h.alert()?.textContent).toContain("models.list unavailable");
  expect(h.page.textContent).toContain("manual request failed");
  h.snapshots("initial");
  expect(h.alert()?.closest(".settings-section")?.querySelector("h2")?.textContent.trim()).toBe(
    "Snapshots",
  );
  delete h.responses["models.list"];
  h.mark("recovered");
  await h.refresh();
  h.snapshots("recovered");
  expect(h.alert()).toBeNull();
  expect(h.page.textContent).toContain("manual request failed");
});
