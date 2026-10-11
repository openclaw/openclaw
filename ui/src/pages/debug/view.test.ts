import hljs from "highlight.js/lib/core";
import { createComponent, createStore, flush } from "solid-js";
import { assert, describe, expect, it, vi } from "vitest";
import { flattenTranslations } from "../../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { zh_CN } from "../../i18n/locales/zh-CN.ts";
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
import { DebugPageView, type DebugProps } from "./view.tsx";

type TestDebugPage = HTMLElement;
const pages = new WeakMap<
  HTMLElement,
  { unmount: () => void; setContext: (context: ApplicationContext) => void }
>();

function mountView(initial: DebugProps, container: HTMLElement) {
  const [props, setProps] = createStore(initial, { shallow: true });
  mountSolid(() => createComponent(DebugPageView, props), { container });
  return (next: DebugProps) => {
    setProps(() => next);
    flush();
  };
}

function mountDebugHost(context: ApplicationContext): TestDebugPage {
  const provider = createSolidApplicationContextProvider(context);
  const mounted = mountSolid(() => createComponent(DebugPage, {}), { wrapper: provider.wrapper });
  const page = mounted.container;
  pages.set(page, { unmount: mounted.unmount, setContext: provider.setContext });
  flush();
  return page;
}

function unmountDebugHost(page: TestDebugPage) {
  pages.get(page)?.unmount();
}

async function updateDebugHost(_host: TestDebugPage): Promise<void> {
  flush();
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
): Promise<TestDebugPage> {
  const page = mountDebugHost(context);
  await updateDebugHost(page);
  await waitForSolid(() => expect(readSnapshot(page, "Status")).toEqual({ version: "initial" }));
  return page;
}

function expectSnapshots(page: TestDebugPage, marker: string): void {
  expect(readSnapshot(page, "Status")).toEqual({ version: marker });
  expect(readSnapshot(page, "Health")).toEqual({ marker, ok: true });
  expect(readSnapshot(page, "Models")).toEqual([{ id: marker }]);
  expect(normalizedText(page.querySelector(".settings-section"))).toContain(
    `Scheduler Enabled · ${marker.length} total jobs`,
  );
  expect(normalizedText(page.querySelector(".command-lane-row"))).toContain(marker);
}

function createProps(overrides: Partial<DebugProps> = {}): DebugProps {
  return {
    connected: true,
    offlineStable: false,
    loading: false,
    status: null,
    health: null,
    models: [],
    automations: null,
    lanes: [],
    dynamic: null,
    diagnosticsError: null,
    eventLog: [],
    methods: [],
    callMethod: "",
    callParams: "{}",
    callResult: null,
    callError: null,
    onCallMethodChange: () => undefined,
    onCallParamsChange: () => undefined,
    onRefresh: () => undefined,
    onOpenOverlay: () => undefined,
    onCall: () => undefined,
    ...overrides,
  };
}

useDebugTestEnvironment();

describe("DebugPageView", () => {
  it.each([
    [true, 1, "Scheduler Enabled · 1 total jobs"],
    [true, 0, "Scheduler Enabled · 0 total jobs"],
    [false, 2, "Scheduler Disabled · 2 total jobs"],
  ] as const)(
    "uses canonical scheduler=%s and total=%s while retaining raw protocol data",
    (enabled, jobs, text) => {
      const container = document.createElement("div");
      const status = {
        heartbeat: { defaultAgentId: "main", agents: [{ enabled: false, every: "disabled" }] },
      };
      const health = { heartbeatSeconds: 0, agents: [] };
      mountView(
        createProps({
          status,
          health,
          automations: { enabled, triggersEnabled: true, jobs, nextWakeAtMs: null },
        }),
        container,
      );
      const sections = container.querySelectorAll(".settings-section");
      expect(normalizedText(sections[0])).toContain(text);
      expect(normalizedText(sections[0])).toContain("none scheduled");
      expect(normalizedText(sections[0])).not.toContain("defaultAgentId");
      expect(normalizedText(sections[1])).toContain("Raw protocol inspection");
      const raw = sections[1]?.querySelectorAll("pre");
      expect(JSON.parse(raw?.[0]?.textContent ?? "null")).toEqual(status);
      expect(JSON.parse(raw?.[1]?.textContent ?? "null")).toEqual(health);
    },
  );

  it("shows unavailable diagnostics instead of claiming a disabled scheduler", () => {
    const container = document.createElement("div");
    mountView(createProps({ diagnosticsError: "cron.status unavailable" }), container);
    const summary = container.querySelector(".settings-section");
    expect(normalizedText(summary)).toContain("Unavailable");
    expect(normalizedText(summary)).toContain("cron.status unavailable");
    expect(normalizedText(summary)).not.toContain("Scheduler Disabled");
  });

  it("retains event payload DOM and only highlights changed diagnostics", () => {
    const container = document.createElement("div");
    const events = Array.from({ length: 250 }, (_, index) => ({
      ts: 1,
      event: "agent",
      payload: { message: `event ${index}` },
    }));
    const props = createProps({ eventLog: events, callResult: '{"ok":true}' });
    const highlight = vi.spyOn(hljs, "highlight");
    try {
      const update = mountView(props, container);
      const eventSection = container.querySelector(".settings-section:last-child");
      assert(eventSection);
      const payloads = Array.from(eventSection.querySelectorAll("pre"));
      assert(payloads[0]);
      const firstToken = payloads[0].querySelector("span");
      assert(firstToken);
      highlight.mockClear();

      const newest = {
        ts: 8_640_000_000_000_001,
        event: "gateway",
        payload: { message: "newest" },
      };
      const nextProps = { ...props, eventLog: [newest, ...events.slice(0, -1)] };
      update(nextProps);

      const nextPayloads = Array.from(eventSection.querySelectorAll("pre"));
      expect(nextPayloads).toHaveLength(250);
      expect(container.textContent).toContain("gateway");
      expect(container.textContent).not.toContain("Invalid Date");
      assert(nextPayloads[0] && nextPayloads[1]);
      expect(nextPayloads[0].textContent).toContain("newest");
      expect(nextPayloads.slice(1)).toEqual(payloads.slice(0, -1));
      expect(nextPayloads[1].querySelector("span")).toBe(firstToken);
      expect(highlight).toHaveBeenCalledTimes(1);

      highlight.mockClear();
      update({ ...nextProps, callParams: '{"typed":true}' });
      expect(highlight).not.toHaveBeenCalled();

      update({
        ...nextProps,
        status: { version: "updated" },
        health: { ok: true },
        automations: { enabled: true, triggersEnabled: true, jobs: 2, nextWakeAtMs: null },
        models: [{ id: "updated" }],
        callResult: '{"result":"updated"}',
      });
      expect(highlight).toHaveBeenCalledTimes(4);
      expect(container.textContent).toContain("updated");

      update({ ...props, eventLog: [] });
      expect(eventSection.querySelector("pre")).toBeNull();
      expect(eventSection.textContent).not.toContain("event 0");
    } finally {
      highlight.mockRestore();
    }
  });

  it("updates security audit labels with the locale and keeps the command monospace", async () => {
    const container = document.createElement("div");

    mountView(
      createProps({
        status: {
          securityAudit: {
            summary: {
              critical: 0,
              warn: 1,
              info: 2,
            },
          },
        },
      }),
      container,
    );

    expect(container.querySelector(".settings-status")?.textContent).toContain("1 warning");
    await i18n.setLocale("zh-CN");
    flush();

    const command = container.querySelector<HTMLElement>(".settings-row__desc .mono");
    if (!command) {
      throw new Error("expected debug security audit command");
    }
    const status = container.querySelector(".settings-status");
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

  it.each<{
    label: string;
    lane: DebugProps["lanes"][number];
    dynamic: DebugProps["dynamic"];
    text: string;
    saturated: boolean;
    queued: boolean;
  }>([
    {
      label: "global",
      text: "main 2/2 3 interactive · 2/4 lane",
      saturated: true,
      queued: true,
      lane: {
        lane: "main",
        activeCount: 2,
        queuedCount: 3,
        maxConcurrent: 2,
        draining: false,
        generation: 0,
        group: "interactive",
        groupActive: 2,
        groupBudget: 4,
        blockedBy: "lane",
      },
      dynamic: { laneCount: 23, activeCount: 9, queuedCount: 4, queuedLaneCount: 3 },
    },
    {
      label: "per-session",
      text: "subagent 16 · 8/session 0",
      saturated: false,
      queued: false,
      lane: {
        lane: "subagent",
        activeCount: 16,
        queuedCount: 0,
        maxConcurrent: 8,
        concurrencyScope: "session",
        saturatedLaneCount: 0,
        draining: false,
        generation: 0,
      },
      dynamic: null,
    },
  ])(
    "renders $label lane capacity and saturation",
    ({ lane, dynamic, text, saturated, queued }) => {
      const container = document.createElement("div");
      const props = createProps({ lanes: [lane], dynamic });
      const update = mountView(props, container);
      const row = container.querySelector(".command-lane-row");
      expect(row?.classList.contains("command-lane-row--saturated")).toBe(saturated);
      expect(row?.classList.contains("command-lane-row--queued")).toBe(queued);
      expect(normalizedText(row)).toContain(text);
      if (dynamic) {
        expect(normalizedText(container.querySelector(".command-lane-row--dynamic"))).toContain(
          "Session lanes · 23 9 4 —",
        );
      } else {
        update({ ...props, lanes: [{ ...lane, saturatedLaneCount: 1 }] });
        expect(container.querySelector(".command-lane-row")?.classList).toContain(
          "command-lane-row--saturated",
        );
      }
    },
  );
});

describe("DebugPage", () => {
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
          if (holdLive && (method === "cron.status" || method === "diagnostics.lanes")) {
            await pending.promise;
            return diagnosticResponse(method, "stale");
          }
          return diagnosticResponse(method, marker);
        },
      );
      const context = createDebugApplicationContext(request);
      const source = createApplicationGateway(context.gateway.snapshot);
      Object.assign(source.gateway, { eventLog: [], subscribeEventLog: () => () => undefined });
      type SelectionListener = Parameters<
        ApplicationContext["settingsAgentSelection"]["subscribe"]
      >[0];
      const listeners = new Set<SelectionListener>();
      const selection = {
        ...context.settingsAgentSelection,
        state: { ...context.settingsAgentSelection.state },
        subscribe: (listener: SelectionListener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
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
          const replacement = createApplicationGateway(source.gateway.snapshot);
          Object.assign(replacement.gateway, {
            eventLog: [],
            subscribeEventLog: () => () => undefined,
          });
          pages.get(page)!.setContext({ ...pageContext, gateway: replacement.gateway });
        } else {
          selection.state.selectedId = "worker";
          for (const listener of listeners) {
            listener(selection.state);
          }
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
        unmountDebugHost(page);
        await vi.advanceTimersByTimeAsync(6_000);
        expect(request).toHaveBeenCalledTimes(count);
      } finally {
        pending.resolve();
        pendingModels.resolve({ models: [] });
        unmountDebugHost(page);
        vi.useRealTimers();
      }
    },
  );

  it("discards pending diagnostics when a replacement provider reuses its client", async () => {
    const pending = deferred<unknown>();
    const request = vi.fn(() => pending.promise);
    const context = createDebugApplicationContext(request);
    const page = mountDebugHost(context);
    expect(request).toHaveBeenCalledTimes(5);
    pages.get(page)!.setContext({
      ...context,
      gateway: { ...context.gateway, snapshot: { ...context.gateway.snapshot, phase: "stopped" } },
    });
    flush();
    pending.resolve({ models: [{ id: "stale" }], stale: true });
    await pending.promise;
    await updateDebugHost(page);
    expect(request).toHaveBeenCalledTimes(5);
    expect(readSnapshot(page, "Status")).toEqual({});
    expect(readSnapshot(page, "Health")).toEqual({});
    expect(readSnapshot(page, "Models")).toEqual([]);
    expect(normalizedText(page.querySelector(".settings-section"))).toContain("Unavailable");
    expect(page.querySelector(".command-lane-row")).toBeNull();
    expect(page.textContent).not.toContain("stale");
  });

  it("polls live lanes and automations while full snapshots change only on Refresh", async () => {
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
      await updateDebugHost(page);
      for (const method of ["status", "health", "models.list"]) {
        expect(request.mock.calls.filter(([called]) => called === method)).toHaveLength(1);
      }
      expect(readSnapshot(page, "Status")).toEqual({ version: "initial" });
      expect(readSnapshot(page, "Health")).toEqual({ marker: "initial", ok: true });
      expect(readSnapshot(page, "Models")).toEqual([{ id: "initial" }]);
      expect(normalizedText(page.querySelector(".settings-section"))).toContain(
        "Scheduler Enabled · 4 total jobs",
      );
      expect(normalizedText(page.querySelector(".command-lane-row"))).toContain("live");
      marker = "manual";
      const refresh = page.querySelector<HTMLButtonElement>(".settings-section button")!;
      refresh.click();
      await updateDebugHost(page);
      expect(refresh.disabled).toBe(true);
      expect(normalizedText(refresh)).toBe("Refreshing…");
      expect(page.querySelector(".settings-section .settings-status")).toBeNull();
      expect(page.textContent).toContain("initial");
      pendingRefresh.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await updateDebugHost(page);
      expectSnapshots(page, "manual");
      for (const method of ["status", "health", "models.list"]) {
        expect(request.mock.calls.filter(([called]) => called === method)).toHaveLength(2);
      }
    } finally {
      pendingRefresh.resolve();
      unmountDebugHost(page);
      vi.useRealTimers();
    }
  });

  it.each(["reconnecting", "offline"] as const)(
    "disables refresh while %s, labeling only stable outages offline",
    async (phase) => {
      const request = vi.fn(async (method: string) => diagnosticResponse(method));
      const page = mountDebugHost(createDebugApplicationContext(request, phase));
      await updateDebugHost(page);
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

  it.each([
    { label: "response", staleError: false },
    { label: "error", staleError: true },
  ])(
    "ignores an older manual RPC $label after the latest call succeeds",
    async ({ staleError }) => {
      const older = deferred<unknown>();
      const request = vi.fn(async (method: string) => {
        if (method === "manual.first") {
          return older.promise;
        }
        if (method === "manual.latest") {
          return { result: "latest response" };
        }
        return diagnosticResponse(method);
      });
      const page = await mountDebugPage(request);

      callMethod(page, "manual.first");
      expect(request).toHaveBeenCalledWith("manual.first", {});
      const olderRequest = request.mock.results.at(-1)!.value;
      callMethod(page, "manual.latest");
      await waitForSolid(() => expect(page.textContent).toContain("latest response"));
      if (staleError) {
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
      const request = vi.fn(async (method: string) => {
        if (method === "manual.latest") {
          if (outcome === "error") {
            throw new Error("previous client failure");
          }
          return { result: "previous client response" };
        }
        return diagnosticResponse(method);
      });
      const initial = createDebugApplicationContext(request);
      const source = createApplicationGateway(initial.gateway.snapshot);
      Object.assign(source.gateway, { eventLog: [], subscribeEventLog: () => () => undefined });
      const context = { ...initial, gateway: source.gateway };
      const page = await mountDebugPage(request, context);
      const rpcSection = page.querySelector("select")?.closest(".settings-section");
      assert(rpcSection);

      callMethod(page, "manual.latest");
      await waitForSolid(() =>
        expect(rpcSection.textContent).toContain(
          outcome === "error" ? "previous client failure" : "previous client response",
        ),
      );
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

  it.each(["models.list", "health"] as const)(
    "preserves snapshots and independent Manual RPC errors through %s failure and recovery",
    async (failedMethod) => {
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
      expect(page.querySelector('.settings-section:first-child [role="alert"]')).toBeNull();

      marker = "uncommitted";
      failure = failedMethod;
      page.querySelector<HTMLButtonElement>(".settings-section button")!.click();
      await waitForSolid(() => expect(page.textContent).toContain(`${failedMethod} unavailable`));

      expect(page.textContent).toContain("manual request failed");
      expectSnapshots(page, "initial");
      const alert = page.querySelector<HTMLElement>('.settings-section [role="alert"]');
      expect(alert?.closest(".settings-section")?.querySelector("h2")?.textContent.trim()).toBe(
        "Snapshots",
      );
      expect(alert?.classList).toContain("settings-row");
      expect(page.querySelector(".callout")).toBeNull();

      marker = "recovered";
      failure = null;
      page.querySelector<HTMLButtonElement>(".settings-section button")!.click();
      await waitForSolid(() => expectSnapshots(page, "recovered"));

      expect(page.querySelector('.settings-section:first-child [role="alert"]')).toBeNull();
      expect(page.textContent).toContain("manual request failed");
    },
  );
});
