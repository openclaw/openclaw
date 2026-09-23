// Control UI tests cover debug behavior.
import hljs from "highlight.js/lib/core";
import { render, type LitElement } from "lit";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { flattenTranslations } from "../../../../scripts/lib/control-ui-i18n-sync-plan.ts";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { SparklineSample } from "../../components/sparkline-tile.ts";
import { i18n } from "../../i18n/index.ts";
import { zh_CN } from "../../i18n/locales/zh-CN.ts";
import "./debug-overlay.ts";
import "./debug-overlay-content.ts";
import "./debug-page.ts";
import { createApplicationGateway } from "../../test-helpers/application-context.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { renderDebug } from "./view.ts";

type DebugProps = Parameters<typeof renderDebug>[0];
const DIAGNOSTIC_METHODS = [
  "diagnostics.lanes",
  "status",
  "health",
  "models.list",
  "last-heartbeat",
] as const;
type DiagnosticMethod = (typeof DIAGNOSTIC_METHODS)[number];

type TestDebugPage = HTMLElement & {
  readonly updateComplete: Promise<boolean>;
  requestUpdate: () => void;
  callDebugMethod: () => Promise<void>;
  context: ApplicationContext;
  debugCallError: string | null;
  debugCallMethod: string;
  debugCallResult: string | null;
  debugDiagnosticsError: string | null;
  debugHealth: unknown;
  debugHeartbeat: unknown;
  debugLanes: unknown[];
  debugModels: unknown[];
  debugStatus: unknown;
  loadDiagnostics: () => Promise<void>;
};

type TestDebugOverlay = LitElement & {
  context: ApplicationContext;
  toggle: () => void;
};

type TestSparkline = LitElement & { samples: readonly SparklineSample[] };

async function updateOverlayVitals(overlay: TestDebugOverlay): Promise<void> {
  await overlay.updateComplete;
  await overlay.querySelector<LitElement>("openclaw-debug-overlay-content")?.updateComplete;
  for (const tile of overlay.querySelectorAll<TestSparkline>("openclaw-sparkline")) {
    await tile.updateComplete;
  }
}

function createDebugApplicationContext(
  request: (method: string) => Promise<unknown>,
  phase: ApplicationGatewaySnapshot["phase"] = "connected",
): ApplicationContext {
  const client = { request } as unknown as GatewayBrowserClient;
  const gateway = {
    snapshot: {
      phase,
      client: phase === "connected" ? client : null,
      offlineStable: phase === "offline",
    } as ApplicationGatewaySnapshot,
    eventLog: [],
    subscribe: () => () => undefined,
    subscribeEventLog: () => () => undefined,
  } as unknown as ApplicationContext["gateway"];
  const settingsAgentSelection = {
    state: { selectedId: "main" },
    subscribe: () => () => undefined,
  } as unknown as ApplicationContext["settingsAgentSelection"];
  return { settingsAgentSelection, basePath: "", gateway } as ApplicationContext;
}

async function mountDebugPage(
  request: (method: string) => Promise<unknown>,
): Promise<TestDebugPage> {
  const page = document.createElement("openclaw-debug-page") as TestDebugPage;
  page.context = createDebugApplicationContext(request);
  document.body.append(page);
  await vi.waitFor(() => expect(page.debugStatus).not.toBeNull());
  return page;
}

function diagnosticResponse(method: string, marker = "initial"): unknown {
  switch (method) {
    case "status":
      return { version: marker };
    case "health":
      return { marker, ok: true };
    case "models.list":
      return { models: [{ id: marker }] };
    case "last-heartbeat":
      return { source: marker };
    case "diagnostics.lanes":
      return {
        ts: 1,
        lanes: [
          {
            lane: marker,
            activeCount: 1,
            queuedCount: 2,
            maxConcurrent: 1,
            draining: false,
            generation: 0,
            blockedBy: "lane",
          },
        ],
        dynamic: null,
      };
    default:
      throw new Error(`Unexpected diagnostics method: ${method}`);
  }
}

function expectSnapshots(page: TestDebugPage, marker: string): void {
  expect(page.debugStatus).toEqual({ version: marker });
  expect(page.debugHealth).toEqual({ marker, ok: true });
  expect(page.debugModels).toEqual([{ id: marker }]);
  expect(page.debugHeartbeat).toEqual({ source: marker });
  expect(page.debugLanes).toEqual([expect.objectContaining({ lane: marker })]);
}

function createProps(overrides: Partial<DebugProps> = {}): DebugProps {
  return {
    connected: true,
    offlineStable: false,
    loading: false,
    status: null,
    health: null,
    models: [],
    heartbeat: null,
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

function normalizedText(element: Element | null | undefined): string | undefined {
  return element?.textContent?.replace(/\s+/gu, " ").trim();
}

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

      const newest = { ts: 1, event: "agent", payload: { message: "newest" } };
      const nextProps = { ...props, eventLog: [newest, ...events.slice(0, -1)] };
      render(renderDebug(nextProps), container);

      const nextPayloads = Array.from(eventSection.querySelectorAll("pre"));
      expect(nextPayloads).toHaveLength(250);
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
          heartbeat: { source: "updated" },
          models: [{ id: "updated" }],
          callResult: '{"result":"updated"}',
        }),
        container,
      );
      expect(highlight).toHaveBeenCalledTimes(5);
      expect(container.textContent).toContain("updated");

      render(renderDebug({ ...props, eventLog: [] }), container);
      expect(eventSection.querySelector("pre")).toBeNull();
      expect(eventSection.textContent).not.toContain("event 0");
    } finally {
      highlight.mockRestore();
    }
  });

  it("disables refresh and explains how to recover while disconnected", () => {
    const container = document.createElement("div");
    render(
      renderDebug(
        createProps({
          connected: false,
          offlineStable: true,
        }),
      ),
      container,
    );
    expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    expect(normalizedText(container.querySelector(".settings-section"))).toContain(
      "Offline Connect to the Gateway to refresh diagnostics.",
    );
  });
  it("keeps refresh progress in the button without hiding last-good snapshots", () => {
    const container = document.createElement("div");
    render(
      renderDebug(
        createProps({
          loading: true,
          status: { version: "last-good" },
        }),
      ),
      container,
    );
    const refresh = container.querySelector<HTMLButtonElement>("button");
    expect(refresh?.disabled).toBe(true);
    expect(normalizedText(refresh)).toBe("Refreshing…");
    expect(container.querySelector(".settings-section .settings-status")).toBeNull();
    expect(container.textContent).toContain("last-good");
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

  it("does not render Invalid Date for Date-invalid event timestamps", () => {
    const container = document.createElement("div");

    render(
      renderDebug(
        createProps({
          eventLog: [
            {
              ts: 8_640_000_000_000_001,
              event: "gateway",
              payload: { ok: true },
            },
          ],
        }),
      ),
      container,
    );

    expect(container.textContent).toContain("gateway");
    expect(container.textContent).not.toContain("Invalid Date");
  });

  it("renders lane diagnostics as an emphasized table", () => {
    const container = document.createElement("div");
    render(
      renderDebug(
        createProps({
          lanes: [
            {
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
          ],
          dynamic: {
            laneCount: 23,
            activeCount: 9,
            queuedCount: 4,
            queuedLaneCount: 3,
          },
        }),
      ),
      container,
    );

    const row = container.querySelector(".command-lane-row");
    expect(row?.classList).toContain("command-lane-row--saturated");
    expect(row?.classList).toContain("command-lane-row--queued");
    expect(normalizedText(row)).toContain("main 2/2 3 interactive · 2/4 lane");
    expect(normalizedText(container.querySelector(".command-lane-row--dynamic"))).toContain(
      "Session lanes · 23 9 4 —",
    );
  });

  it("uses per-session capacity when displaying aggregate subagent activity", () => {
    const container = document.createElement("div");
    const lane = {
      lane: "subagent",
      activeCount: 16,
      queuedCount: 0,
      maxConcurrent: 8,
      concurrencyScope: "session" as const,
      saturatedLaneCount: 0,
      draining: false,
      generation: 0,
    };
    render(renderDebug(createProps({ lanes: [lane] })), container);

    let row = container.querySelector(".command-lane-row");
    expect(normalizedText(row)).toContain("subagent 16 · 8/session 0");
    expect(row?.classList).not.toContain("command-lane-row--saturated");

    render(renderDebug(createProps({ lanes: [{ ...lane, saturatedLaneCount: 1 }] })), container);
    row = container.querySelector(".command-lane-row");
    expect(row?.classList).toContain("command-lane-row--saturated");
  });
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
          if (holdLive && (method === "last-heartbeat" || method === "diagnostics.lanes")) {
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

  it("polls live lanes and heartbeat while full snapshots change only on Refresh", async () => {
    vi.useFakeTimers();
    let marker = "initial";
    const request = vi.fn(async (method: string) => diagnosticResponse(method, marker));
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
      expect(page.debugHeartbeat).toEqual({ source: "live" });
      expect(page.debugLanes).toEqual([expect.objectContaining({ lane: "live" })]);
      expect(normalizedText(page.querySelector(".command-lane-row"))).toContain("live");
      marker = "manual";
      page.querySelector<HTMLButtonElement>(".settings-section button")!.click();
      await vi.advanceTimersByTimeAsync(0);
      await page.updateComplete;
      expectSnapshots(page, "manual");
      for (const method of ["status", "health", "models.list"]) {
        expect(request.mock.calls.filter(([called]) => called === method)).toHaveLength(2);
      }
    } finally {
      page.remove();
      vi.useRealTimers();
    }
  });

  it("does not report a transient Gateway reconnect as offline", async () => {
    const request = vi.fn(async (method: string) => diagnosticResponse(method));
    const page = document.createElement("openclaw-debug-page") as TestDebugPage;
    page.context = createDebugApplicationContext(request, "reconnecting");
    document.body.append(page);
    await page.updateComplete;
    const refresh = page.querySelector<HTMLButtonElement>("button");
    expect(refresh?.disabled).toBe(true);
    expect(normalizedText(page.querySelector(".settings-section"))).not.toContain("Offline");
  });

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

  it.each(DIAGNOSTIC_METHODS)(
    "preserves every last-good snapshot and recovers after %s fails",
    async (failedMethod) => {
      let failure: DiagnosticMethod | null = null;
      let marker = "initial";
      const request = vi.fn(async (method: string) => {
        if (method === failure) {
          throw new Error(`${method} unavailable`);
        }
        return diagnosticResponse(method, marker);
      });
      const page = await mountDebugPage(request);
      expectSnapshots(page, "initial");

      marker = "uncommitted";
      failure = failedMethod;
      await page.loadDiagnostics();
      await page.updateComplete;

      expect(page.debugDiagnosticsError).toContain(`${failedMethod} unavailable`);
      expectSnapshots(page, "initial");
      const alert = page.querySelector<HTMLElement>('[role="alert"]');
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
    },
  );

  it("keeps failed Manual RPC state separate from diagnostics failure and recovery", async () => {
    let diagnosticsUnavailable = false;
    const request = vi.fn(async (method: string) => {
      if (method === "manual.latest") {
        throw new Error("manual request failed");
      }
      if (method === "health" && diagnosticsUnavailable) {
        throw new Error("background snapshots unavailable");
      }
      return diagnosticResponse(method);
    });
    const page = await mountDebugPage(request);
    page.debugCallMethod = "manual.latest";
    await page.callDebugMethod();

    expect(page.debugCallError).toContain("manual request failed");
    expect(page.debugDiagnosticsError).toBeNull();

    diagnosticsUnavailable = true;
    await page.loadDiagnostics();

    expect(page.debugDiagnosticsError).toContain("background snapshots unavailable");
    expect(page.debugCallError).toContain("manual request failed");
  });
});

describe("DebugOverlay", () => {
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
      await vi.advanceTimersByTimeAsync(6_000);
      await updateOverlayVitals(overlay);
      expect(requestCount("sessions.list")).toBe(1);
      expect(requestCount("diagnostics.lanes")).toBe(4);
      expect(requestCount("system.info")).toBe(4);
      expect(normalizedText(overlay.querySelector(".gateway-vital--cpu"))).toContain("40%");
      expect(eventListeners.size).toBe(1);

      overlay.querySelector<HTMLButtonElement>('[aria-label="Minimize system busyness"]')!.click();
      await updateOverlayVitals(overlay);
      expect(eventListeners.size).toBe(0);
      await vi.advanceTimersByTimeAsync(2_000);
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
      await vi.advanceTimersByTimeAsync(2_000);
      expect(requestCount("sessions.list")).toBe(2);
      expect(requestCount("diagnostics.lanes")).toBe(5);
      expect(requestCount("system.info")).toBe(6);

      overlay.toggle();
      await updateOverlayVitals(overlay);
      expect(eventListeners.size).toBe(0);
      const closedCount = request.mock.calls.length;
      await vi.advanceTimersByTimeAsync(6_000);
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
      await vi.advanceTimersByTimeAsync(6_000);
      expect(request).not.toHaveBeenCalled();

      setVisibility("visible");
      globalThis.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
      await updateOverlayVitals(overlay);
      expectReadCount(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expectReadCount(2);

      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(6_000);
      expectReadCount(2);
      setVisibility("visible");
      globalThis.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
      expectReadCount(3);

      overlay.toggle();
      await updateOverlayVitals(overlay);
      setVisibility("hidden");
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(6_000);
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

      await vi.advanceTimersByTimeAsync(2_000);
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

      await vi.advanceTimersByTimeAsync(180_000);
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
        "Uptime 0ms",
      );

      diskResponse = "single";
      await vi.advanceTimersByTimeAsync(2_000);
      await vitalUpdated();
      expect(overlay.querySelectorAll(".gateway-vital--disk")).toHaveLength(1);
      expect(diskTile("/")?.samples).toHaveLength(2);
      diskResponse = "available";
      await vi.advanceTimersByTimeAsync(2_000);
      await vitalUpdated();
      expect(diskTile("/")?.samples).toHaveLength(3);
      expect(diskTile("/Volumes/Archive")?.samples).toHaveLength(1);

      for (const response of ["empty", "legacy", "missing"] as const) {
        diskResponse = response;
        await vi.advanceTimersByTimeAsync(2_000);
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
      await vi.advanceTimersByTimeAsync(2_000);
      await vitalUpdated();
      expect(overlay.querySelectorAll(".gateway-vital")).toHaveLength(0);
      expect(normalizedText(overlay)).toContain("Unavailable");
      diskResponse = "available";
      await vi.advanceTimersByTimeAsync(2_000);
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
      await vi.advanceTimersByTimeAsync(2_000);
      await updateOverlayVitals(overlay);
      expect(overlay.querySelector<TestSparkline>(".gateway-vital--disk")?.samples).toHaveLength(2);

      infoResponse = pending.promise;
      await vi.advanceTimersByTimeAsync(2_000);
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
        publishSnapshot({ ...snapshot, phase: "connected" });
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

      await vi.advanceTimersByTimeAsync(2_000);
      await updateOverlayVitals(overlay);
      expect(disk?.samples.map((sample) => sample.value / 1_073_741_824)).toEqual([200, 200]);
    } finally {
      overlay.remove();
      vi.useRealTimers();
    }
    expect(listeners.size).toBe(0);
  });
});
