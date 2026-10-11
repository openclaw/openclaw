import hljs from "highlight.js/lib/core";
import { render } from "lit";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { flattenTranslations } from "../../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";

import { i18n } from "../../i18n/index.ts";
import { zh_CN } from "../../i18n/locales/zh-CN.ts";
import "./debug-overlay.ts";
import "./debug-overlay-content.ts";
import "./debug-page.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createDebugApplicationContext,
  createProps,
  diagnosticResponse,
  expectSnapshots,
  mountDebugPage,
  normalizedText,
  updateOverlayVitals,
  type TestDebugPage,
  type TestDebugOverlay,
  type TestSparkline,
} from "./view.test-support.ts";
import { renderDebug } from "./view.ts";

beforeEach(async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  // Polling fixtures use reduced motion; layout and browser tests own animation coverage.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)",
  }));
  // JSDOM has no layout observation; browser tests exercise real panel geometry.
  if (typeof ResizeObserver === "undefined") {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  }
  await i18n.setLocale("en");
});

afterEach(async () => {
  document.body.replaceChildren();
  await i18n.setLocale("en");
  vi.unstubAllGlobals();
});

describe("renderDebug", () => {
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
      render(
        renderDebug(
          createProps({
            status,
            health,
            automations: { enabled, triggersEnabled: true, jobs, nextWakeAtMs: null },
          }),
        ),
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
    render(renderDebug(createProps({ diagnosticsError: "cron.status unavailable" })), container);
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
      render(renderDebug(props), container);
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
      render(renderDebug(nextProps), container);

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
      render(renderDebug({ ...nextProps, callParams: '{"typed":true}' }), container);
      expect(highlight).not.toHaveBeenCalled();

      render(
        renderDebug({
          ...nextProps,
          status: { version: "updated" },
          health: { ok: true },
          automations: { enabled: true, triggersEnabled: true, jobs: 2, nextWakeAtMs: null },
          models: [{ id: "updated" }],
          callResult: '{"result":"updated"}',
        }),
        container,
      );
      expect(highlight).toHaveBeenCalledTimes(4);
      expect(container.textContent).toContain("updated");

      render(renderDebug({ ...props, eventLog: [] }), container);
      expect(eventSection.querySelector("pre")).toBeNull();
      expect(eventSection.textContent).not.toContain("event 0");
    } finally {
      highlight.mockRestore();
    }
  });

  it("keeps the security audit command styled as monospace", async () => {
    await i18n.setLocale("zh-CN");
    const container = document.createElement("div");

    render(
      renderDebug(
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
      ),
      container,
    );

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
    lane: Parameters<typeof renderDebug>[0]["lanes"][number];
    dynamic: Parameters<typeof renderDebug>[0]["dynamic"];
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
      render(renderDebug(props), container);
      const row = container.querySelector(".command-lane-row");
      expect(row?.classList.contains("command-lane-row--saturated")).toBe(saturated);
      expect(row?.classList.contains("command-lane-row--queued")).toBe(queued);
      expect(normalizedText(row)).toContain(text);
      if (dynamic) {
        expect(normalizedText(container.querySelector(".command-lane-row--dynamic"))).toContain(
          "Session lanes · 23 9 4 —",
        );
      } else {
        render(renderDebug({ ...props, lanes: [{ ...lane, saturatedLaneCount: 1 }] }), container);
        expect(container.querySelector(".command-lane-row")?.classList).toContain(
          "command-lane-row--saturated",
        );
      }
    },
  );
});

describe("DebugPage", () => {
  it.each(["reconnect", "source", "agent"] as const)(
    "retires a pending live poll and refreshes snapshots after a %s change",
    async (change) => {
      vi.useFakeTimers();
      const pending = deferred();
      let marker = "initial";
      let holdLive = false;
      const request = vi.fn(
        async (method: string, _params?: unknown, _options?: { signal?: AbortSignal }) => {
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
      const page = document.createElement("openclaw-debug-page") as TestDebugPage;
      page.context = { ...context, gateway: source.gateway, settingsAgentSelection: selection };
      document.body.append(page);
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
        if (change === "reconnect") {
          source.publish({ ...source.gateway.snapshot, phase: "reconnecting" });
          source.publish({ ...source.gateway.snapshot, phase: "connected" });
        } else if (change === "source") {
          const replacement = createApplicationGateway(source.gateway.snapshot);
          Object.assign(replacement.gateway, {
            eventLog: [],
            subscribeEventLog: () => () => undefined,
          });
          page.context = { ...page.context, gateway: replacement.gateway };
          page.requestUpdate();
        } else {
          selection.state.selectedId = "worker";
          for (const listener of listeners) {
            listener(selection.state);
          }
        }
        await vi.advanceTimersByTimeAsync(0);
        expectSnapshots(page, "current");
        for (const call of heldCalls) {
          expect(call[2]?.signal?.aborted).toBe(true);
        }
        pending.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expectSnapshots(page, "current");
        expect(request.mock.calls.filter(([method]) => method === "status")).toHaveLength(2);
        const count = request.mock.calls.length;
        page.remove();
        await vi.advanceTimersByTimeAsync(6_000);
        expect(request).toHaveBeenCalledTimes(count);
      } finally {
        pending.resolve();
        page.remove();
        vi.useRealTimers();
      }
    },
  );

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
      await page.updateComplete;
      for (const method of ["status", "health", "models.list"]) {
        expect(request.mock.calls.filter(([called]) => called === method)).toHaveLength(1);
      }
      expect(page.debugStatus).toEqual({ version: "initial" });
      expect(page.debugHealth).toEqual({ marker: "initial", ok: true });
      expect(page.debugModels).toEqual([{ id: "initial" }]);
      expect(page.debugAutomations).toEqual({
        enabled: true,
        triggersEnabled: true,
        jobs: 4,
        nextWakeAtMs: null,
      });
      expect(page.debugLanes).toEqual([expect.objectContaining({ lane: "live" })]);
      expect(normalizedText(page.querySelector(".command-lane-row"))).toContain("live");
      marker = "manual";
      const refresh = page.querySelector<HTMLButtonElement>(".settings-section button")!;
      refresh.click();
      await page.updateComplete;
      expect(refresh.disabled).toBe(true);
      expect(normalizedText(refresh)).toBe("Refreshing…");
      expect(page.querySelector(".settings-section .settings-status")).toBeNull();
      expect(page.textContent).toContain("initial");
      pendingRefresh.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await page.updateComplete;
      expectSnapshots(page, "manual");
      for (const method of ["status", "health", "models.list"]) {
        expect(request.mock.calls.filter(([called]) => called === method)).toHaveLength(2);
      }
    } finally {
      pendingRefresh.resolve();
      page.remove();
      vi.useRealTimers();
    }
  });

  it.each(["reconnecting", "offline"] as const)(
    "disables refresh while %s, labeling only stable outages offline",
    async (phase) => {
      const request = vi.fn(async (method: string) => diagnosticResponse(method));
      const page = document.createElement("openclaw-debug-page") as TestDebugPage;
      page.context = createDebugApplicationContext(request, phase);
      document.body.append(page);
      await page.updateComplete;
      expect(page.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
      const text = normalizedText(page.querySelector(".settings-section"));
      if (phase === "offline") {
        expect(text).toContain("Offline Connect to the Gateway to refresh diagnostics.");
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

      page.debugCallMethod = "manual.first";
      const olderCall = page.callDebugMethod();
      page.debugCallMethod = "manual.latest";
      await page.callDebugMethod();
      if (staleError) {
        older.reject(new Error("stale manual failure"));
      } else {
        older.resolve({ result: "stale response" });
      }
      await olderCall;

      expect(page.debugCallResult).toContain("latest response");
      expect(page.debugCallResult).not.toContain("stale response");
      expect(page.debugCallError).toBeNull();
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
      page.debugCallMethod = "manual.latest";
      await page.callDebugMethod();
      expect(page.debugCallError).toContain("manual request failed");
      expect(page.debugDiagnosticsError).toBeNull();

      marker = "uncommitted";
      failure = failedMethod;
      await page.loadDiagnostics();
      await page.updateComplete;

      expect(page.debugDiagnosticsError).toContain(`${failedMethod} unavailable`);
      expect(page.debugCallError).toContain("manual request failed");
      expectSnapshots(page, "initial");
      const alert = page.querySelector<HTMLElement>('.settings-section [role="alert"]');
      expect(alert?.closest(".settings-section")?.querySelector("h2")?.textContent.trim()).toBe(
        "Snapshots",
      );
      expect(alert?.classList).toContain("settings-row");
      expect(page.querySelector(".callout")).toBeNull();

      marker = "recovered";
      failure = null;
      await page.loadDiagnostics();

      expect(page.debugDiagnosticsError).toBeNull();
      expectSnapshots(page, "recovered");
      expect(page.debugCallError).toContain("manual request failed");
    },
  );
});

describe("DebugOverlay", () => {
  it("shows canonical job outcomes, redacts reasons, and omits compatibility alias noise", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (method: string) =>
      method === "sessions.list"
        ? { sessions: [] }
        : method === "system.info"
          ? {}
          : diagnosticResponse(method),
    );
    const overlay = document.createElement("openclaw-debug-overlay") as TestDebugOverlay;
    overlay.context = createDebugApplicationContext(request);
    Object.assign(overlay.context.gateway, {
      eventLog: [
        { ts: 3, event: "heartbeat", payload: { status: "skipped", reason: "alias only" } },
        {
          ts: 2,
          event: "cron",
          payload: {
            jobId: "monitor-42",
            runId: "run-17",
            action: "finished",
            status: "skipped",
            error: "owner unavailable; token=synthetic-private-token",
            job: { payload: { message: "private prompt" } },
            summary: "private scratch",
          },
        },
        {
          ts: 1,
          event: "cron",
          payload: { action: "finished", status: "error", error: "No route" },
        },
      ],
    });
    document.body.append(overlay);
    try {
      overlay.toggle();
      await vi.advanceTimersByTimeAsync(0);
      await updateOverlayVitals(overlay);
      const rows = overlay.querySelectorAll(".debug-overlay__events li");
      expect(rows).toHaveLength(2);
      expect(normalizedText(rows[0])).toContain(
        "cron · Job monitor-42 · Run run-17 · skipped · owner unavailable",
      );
      expect(normalizedText(rows[0])).not.toContain("synthetic-private-token");
      expect(normalizedText(rows[0])).not.toContain("private prompt");
      expect(normalizedText(rows[0])).not.toContain("private scratch");
      expect(normalizedText(rows[1])).toContain("cron · error · No route");
      expect(normalizedText(rows[1])).not.toContain("Job");
      expect(normalizedText(rows[1])).not.toContain("Run");
    } finally {
      overlay.remove();
      vi.useRealTimers();
    }
  });

  it("keeps vitals live while an active-run read is pending and minimizes invisible work", async () => {
    vi.useFakeTimers();
    const heldRuns = deferred<unknown>();
    const eventListeners = new Set<() => void>();
    let sampleCount = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "system.info") {
        return { eventLoop: { cpuCoreRatio: ++sampleCount / 10 } };
      }
      if (method === "sessions.list") {
        return heldRuns.promise;
      }
      return diagnosticResponse(method);
    });
    const context = createDebugApplicationContext(request);
    Object.assign(context.gateway, {
      subscribeEventLog(listener: () => void) {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
    });
    const overlay = document.createElement("openclaw-debug-overlay") as TestDebugOverlay;
    overlay.context = context;
    document.body.append(overlay);
    const requestCount = (method: string) =>
      request.mock.calls.filter(([called]) => called === method).length;
    try {
      overlay.toggle();
      await vi.advanceTimersByTimeAsync(30_000);
      await updateOverlayVitals(overlay);
      expect(requestCount("sessions.list")).toBe(1);
      expect(requestCount("diagnostics.lanes")).toBe(4);
      expect(requestCount("system.info")).toBe(4);
      expect(normalizedText(overlay.querySelector(".gateway-vital--cpu"))).toContain("40%");
      expect(eventListeners.size).toBe(1);

      overlay.querySelector<HTMLButtonElement>('[aria-label="Minimize system busyness"]')!.click();
      await updateOverlayVitals(overlay);
      expect(eventListeners.size).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      await updateOverlayVitals(overlay);
      expect(requestCount("sessions.list")).toBe(1);
      expect(requestCount("diagnostics.lanes")).toBe(4);
      expect(requestCount("system.info")).toBe(5);
      expect(normalizedText(overlay.querySelector(".gateway-vital--cpu"))).toContain("50%");

      heldRuns.resolve({ sessions: [] });
      await vi.advanceTimersByTimeAsync(0);
      overlay.querySelector<HTMLButtonElement>('[aria-label="Expand system busyness"]')!.click();
      await updateOverlayVitals(overlay);
      expect(eventListeners.size).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(requestCount("sessions.list")).toBe(2);
      expect(requestCount("diagnostics.lanes")).toBe(5);
      expect(requestCount("system.info")).toBe(6);

      overlay.toggle();
      await updateOverlayVitals(overlay);
      expect(eventListeners.size).toBe(0);
      const closedCount = request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(request).toHaveBeenCalledTimes(closedCount);
    } finally {
      heldRuns.resolve({ sessions: [] });
      overlay.remove();
      vi.useRealTimers();
    }
  });

  it("defers hidden reads and catches up once when the tray becomes visible", async () => {
    vi.useFakeTimers();
    let visibility: DocumentVisibilityState = "hidden";
    const visibilitySpy = vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility);
    const setVisibility = (value: DocumentVisibilityState) => {
      visibility = value;
      document.dispatchEvent(new Event("visibilitychange"));
    };
    const request = vi.fn(async (method: string) => {
      if (method === "system.info") {
        return { eventLoop: { cpuCoreRatio: 0.2 } };
      }
      return method === "sessions.list" ? { sessions: [] } : diagnosticResponse(method);
    });
    const overlay = document.createElement("openclaw-debug-overlay") as TestDebugOverlay;
    overlay.context = createDebugApplicationContext(request);
    document.body.append(overlay);
    const expectReadCount = (count: number) => {
      for (const method of ["system.info", "sessions.list", "diagnostics.lanes"]) {
        expect(
          request.mock.calls.filter(([called]) => called === method),
          method,
        ).toHaveLength(count);
      }
    };
    try {
      overlay.toggle();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(request).not.toHaveBeenCalled();

      setVisibility("visible");
      globalThis.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
      await updateOverlayVitals(overlay);
      expectReadCount(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expectReadCount(2);

      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(30_000);
      expectReadCount(2);
      setVisibility("visible");
      globalThis.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
      expectReadCount(3);

      overlay.toggle();
      await updateOverlayVitals(overlay);
      setVisibility("hidden");
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(30_000);
      expectReadCount(3);
    } finally {
      overlay.remove();
      visibilitySpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("graphs bounded status samples without clamping CPU and resets history on reopen", async () => {
    vi.useFakeTimers();
    let sampleCount = 0;
    let uptimeMs = 60_000;
    let diskResponse: "available" | "single" | "empty" | "legacy" | "missing" | "rejected" =
      "available";
    const request = vi.fn(async (method: string) => {
      if (method === "system.info") {
        sampleCount += 1;
        const vitals = {
          eventLoop: {
            utilization: 0.42,
            cpuCoreRatio: 1 + sampleCount / 10,
            delayP99Ms: 10 + sampleCount,
            delayMaxMs: 87,
          },
          processMemory: {
            rssBytes: (400 + sampleCount) * 1_048_576,
            heapUsedBytes: 100 * 1_048_576,
            heapTotalBytes: 200 * 1_048_576,
          },
        };
        if (diskResponse === "rejected") {
          throw new Error("system info unavailable");
        }
        if (diskResponse === "legacy") {
          return { ...vitals, diskAvailableBytes: 500, diskTotalBytes: 1000, diskPath: "/legacy" };
        }
        if (diskResponse === "missing") {
          return vitals;
        }
        const disks = [
          {
            availableBytes: (700 - sampleCount) * 1_073_741_824,
            totalBytes: 1_000 * 1_073_741_824,
            path: "/",
          },
          {
            availableBytes: (300 - sampleCount * 2) * 1_073_741_824,
            totalBytes: 500 * 1_073_741_824,
            path: "/Volumes/Archive",
          },
        ];
        if (diskResponse === "single") {
          disks.pop();
        } else if (diskResponse === "empty") {
          disks.length = 0;
        }
        return { ...vitals, uptimeMs, disks: sampleCount % 2 ? disks : disks.toReversed() };
      }
      if (method === "sessions.list") {
        return { sessions: [] };
      }
      return diagnosticResponse(method);
    });
    const overlay = document.createElement("openclaw-debug-overlay") as TestDebugOverlay;
    overlay.context = createDebugApplicationContext(request);
    document.body.append(overlay);

    try {
      overlay.toggle();
      await vi.advanceTimersByTimeAsync(0);
      await overlay.updateComplete;

      const vitalUpdated = () => updateOverlayVitals(overlay);
      await vitalUpdated();
      expect(
        request.mock.calls
          .filter(([method]) => method === "status" || method === "system.info")
          .map(([method]) => method),
      ).toEqual(["system.info"]);
      const diskTile = (mountPath: string) =>
        overlay.querySelector<TestSparkline>(`.gateway-vital--disk[title="${mountPath}"]`);
      const rootDisk = diskTile("/");
      const archiveDisk = diskTile("/Volumes/Archive");

      // One sample: tiles show current values, charts wait for a second point.
      expect(overlay.querySelectorAll(".gateway-vital")).toHaveLength(5);
      expect(normalizedText(overlay.querySelector(".gateway-vital--cpu"))).toContain("Host —");
      expect(normalizedText(overlay.querySelector(".gateway-cpu-detail"))).toContain(
        "Event loop busy 42%",
      );
      expect(overlay.querySelector(".sparkline-tile__chart")).toBeNull();
      expect(normalizedText(overlay.querySelector(".debug-overlay__vitals-footer"))).toBe(
        "Uptime 1m",
      );

      await vi.advanceTimersByTimeAsync(10_000);
      await vitalUpdated();

      expect(normalizedText(overlay.querySelector(".gateway-vital--cpu"))).toContain("120%");
      expect(normalizedText(overlay.querySelector(".gateway-vital--memory"))).toContain("402 MB");
      expect(normalizedText(overlay.querySelector(".gateway-vital--memory"))).toContain(
        "heap 100 MB",
      );
      expect(normalizedText(overlay.querySelector(".gateway-vital--delay"))).toContain("12ms");
      expect(normalizedText(overlay.querySelector(".gateway-vital--delay"))).toContain("max 87ms");
      expect(normalizedText(diskTile("/"))).toContain("698 GB free");
      expect(normalizedText(diskTile("/"))).toContain("1000 GB total");
      expect(normalizedText(diskTile("/")?.querySelector(".sparkline-tile__label"))).toBe("Disk /");
      expect(
        normalizedText(diskTile("/Volumes/Archive")?.querySelector(".sparkline-tile__label")),
      ).toBe("Disk /Volumes/Archive");
      expect(normalizedText(diskTile("/Volumes/Archive"))).toContain("296 GB free");
      expect(normalizedText(diskTile("/Volumes/Archive"))).toContain("500 GB total");
      expect(diskTile("/")).toBe(rootDisk);
      expect(diskTile("/Volumes/Archive")).toBe(archiveDisk);
      expect(rootDisk?.samples.map((sample) => sample.value / 1_073_741_824)).toEqual([699, 698]);
      expect(archiveDisk?.samples.map((sample) => sample.value / 1_073_741_824)).toEqual([
        298, 296,
      ]);
      expect(overlay.querySelectorAll(".sparkline-tile__chart")).toHaveLength(5);
      // Healthy event loop: no tile carries the degraded tint.
      expect(overlay.querySelector(".gateway-vital[data-degraded]")).toBeNull();

      await vi.advanceTimersByTimeAsync(900_000);
      await vitalUpdated();

      const points = overlay
        .querySelector(".gateway-vital--cpu polyline")
        ?.getAttribute("points")
        ?.split(" ");
      expect(points).toHaveLength(90);

      uptimeMs = 0;
      overlay.toggle();
      overlay.toggle();
      await vi.advanceTimersByTimeAsync(0);
      await vitalUpdated();

      expect(overlay.querySelectorAll(".gateway-vital")).toHaveLength(5);
      expect(overlay.querySelector(".sparkline-tile__chart")).toBeNull();
      expect(normalizedText(overlay.querySelector(".debug-overlay__vitals-footer"))).toBe(
        "Uptime 1m",
      );

      diskResponse = "single";
      await vi.advanceTimersByTimeAsync(10_000);
      await vitalUpdated();
      expect(overlay.querySelectorAll(".gateway-vital--disk")).toHaveLength(1);
      expect(diskTile("/")?.samples).toHaveLength(2);
      diskResponse = "available";
      await vi.advanceTimersByTimeAsync(10_000);
      await vitalUpdated();
      expect(diskTile("/")?.samples).toHaveLength(3);
      expect(diskTile("/Volumes/Archive")?.samples).toHaveLength(1);

      for (const response of ["empty", "legacy", "missing"] as const) {
        diskResponse = response;
        await vi.advanceTimersByTimeAsync(10_000);
        await vitalUpdated();

        expect(overlay.querySelectorAll(".gateway-vital")).toHaveLength(3);
        expect(overlay.querySelector(".gateway-vital--disk")).toBeNull();
        expect(normalizedText(overlay.querySelector(".debug-overlay__vitals-footer"))).toBe(
          response === "empty" ? "Uptime 0ms" : undefined,
        );
        for (const vital of ["cpu", "memory", "delay"]) {
          expect(overlay.querySelector(`.gateway-vital--${vital}`)).not.toBeNull();
        }
      }
      diskResponse = "rejected";
      await vi.advanceTimersByTimeAsync(10_000);
      await vitalUpdated();
      expect(overlay.querySelectorAll(".gateway-vital")).toHaveLength(0);
      expect(normalizedText(overlay)).toContain("Unavailable");
      diskResponse = "available";
      await vi.advanceTimersByTimeAsync(10_000);
      await vitalUpdated();
      expect(overlay.querySelectorAll(".gateway-vital")).toHaveLength(5);
      expect(request.mock.calls.some(([method]) => method === "status")).toBe(false);
    } finally {
      overlay.remove();
      vi.useRealTimers();
    }
  });

  it.each([
    "same-client reconnect",
    "client replacement",
    "Gateway source replacement",
    "close and reopen",
  ])("discards pending samples and prior disk history on %s", async (transition) => {
    vi.useFakeTimers();
    const listeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
    const pending = deferred<unknown>();
    const firstInfo = {
      disks: [{ path: "/", totalBytes: 1000 * 1_073_741_824, availableBytes: 700 * 1_073_741_824 }],
      diskPath: "/",
      diskTotalBytes: 1000 * 1_073_741_824,
      diskAvailableBytes: 700 * 1_073_741_824,
    };
    let infoResponse: unknown = firstInfo;
    const request = vi.fn(async (method: string) => {
      if (method === "system.info") {
        return infoResponse;
      }
      if (method === "sessions.list") {
        return { sessions: [] };
      }
      return diagnosticResponse(method);
    });
    const context = createDebugApplicationContext(request);
    let snapshot = context.gateway.snapshot;
    const gateway = {
      ...context.gateway,
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (snapshot: ApplicationGatewaySnapshot) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
    const publishSnapshot = (next: ApplicationGatewaySnapshot) => {
      snapshot = next;
      for (const listener of listeners) {
        listener(snapshot);
      }
    };
    const overlay = document.createElement("openclaw-debug-overlay") as TestDebugOverlay;
    overlay.context = { ...context, gateway };
    document.body.append(overlay);
    try {
      overlay.toggle();
      await vi.advanceTimersByTimeAsync(10_000);
      await updateOverlayVitals(overlay);
      expect(overlay.querySelector<TestSparkline>(".gateway-vital--disk")?.samples).toHaveLength(2);

      infoResponse = pending.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      await updateOverlayVitals(overlay);
      expect(normalizedText(overlay.querySelector(".gateway-vital--disk"))).toContain(
        "700 GB free",
      );
      expect(overlay.querySelector(".debug-overlay__placeholder")).toBeNull();
      const callsBeforeTransition = request.mock.calls.filter(
        ([method]) => method === "system.info",
      ).length;
      infoResponse = {
        disks: [{ ...firstInfo.disks[0], availableBytes: 200 * 1_073_741_824 }],
        diskPath: "/",
        diskTotalBytes: firstInfo.diskTotalBytes,
        diskAvailableBytes: 200 * 1_073_741_824,
      };
      if (transition === "same-client reconnect") {
        publishSnapshot({ ...snapshot, phase: "reconnecting" });
        await overlay.updateComplete;
        expect(overlay.querySelector(".gateway-vital--disk")).toBeNull();
        publishSnapshot({
          ...snapshot,
          phase: "connected",
          hello: gatewayHelloForMethods(["system.info"]),
        });
      } else if (transition === "client replacement") {
        publishSnapshot({
          ...snapshot,
          client: createDebugApplicationContext(request).gateway.snapshot.client,
        });
      } else if (transition === "close and reopen") {
        overlay.toggle();
        overlay.toggle();
      } else {
        overlay.context = { ...context, gateway: { ...gateway } };
        overlay.requestUpdate();
      }
      await vi.advanceTimersByTimeAsync(0);
      await updateOverlayVitals(overlay);
      expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(
        callsBeforeTransition + 1,
      );

      pending.resolve(firstInfo);
      await vi.advanceTimersByTimeAsync(0);
      await updateOverlayVitals(overlay);
      const disk = overlay.querySelector<TestSparkline>(".gateway-vital--disk");
      expect(normalizedText(disk)).toContain("200 GB free");
      expect(disk?.samples.map((sample) => sample.value / 1_073_741_824)).toEqual([200]);
      expect(disk?.querySelector("polyline")).toBeNull();

      await vi.advanceTimersByTimeAsync(10_000);
      await updateOverlayVitals(overlay);
      expect(disk?.samples.map((sample) => sample.value / 1_073_741_824)).toEqual([200, 200]);
    } finally {
      overlay.remove();
      vi.useRealTimers();
    }
    expect(listeners.size).toBe(0);
  });
});
