import type { LitElement } from "lit";
import { expect, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { SparklineSample } from "../../components/sparkline-tile.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import type { renderDebug } from "./view.ts";

type DebugProps = Parameters<typeof renderDebug>[0];
export type TestDebugPage = HTMLElement & {
  readonly updateComplete: Promise<boolean>;
  requestUpdate: () => void;
  callDebugMethod: () => Promise<void>;
  context: ApplicationContext;
  debugCallError: string | null;
  debugCallMethod: string;
  debugCallResult: string | null;
  debugDiagnosticsError: string | null;
  debugHealth: unknown;
  debugAutomations: unknown;
  debugLanes: unknown[];
  debugModels: unknown[];
  debugStatus: unknown;
  loadDiagnostics: () => Promise<void>;
};

export type TestDebugOverlay = LitElement & {
  context: ApplicationContext;
  toggle: () => void;
};

export type TestSparkline = LitElement & { samples: readonly SparklineSample[] };

export async function updateOverlayVitals(overlay: TestDebugOverlay): Promise<void> {
  await overlay.updateComplete;
  await overlay.querySelector<LitElement>("openclaw-debug-overlay-content")?.updateComplete;
  for (const tile of overlay.querySelectorAll<TestSparkline>("openclaw-sparkline")) {
    await tile.updateComplete;
  }
}

export function createDebugApplicationContext(
  request: (method: string) => Promise<unknown>,
  phase: ApplicationGatewaySnapshot["phase"] = "connected",
): ApplicationContext {
  const client = { request } as unknown as GatewayBrowserClient;
  const gateway = {
    snapshot: {
      phase,
      client: phase === "connected" ? client : null,
      hello: gatewayHelloForMethods(["system.info"]),
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

export async function mountDebugPage(
  request: (method: string) => Promise<unknown>,
): Promise<TestDebugPage> {
  const page = document.createElement("openclaw-debug-page") as TestDebugPage;
  page.context = createDebugApplicationContext(request);
  document.body.append(page);
  await vi.waitFor(() => expect(page.debugStatus).not.toBeNull());
  return page;
}

export function diagnosticResponse(method: string, marker = "initial"): unknown {
  switch (method) {
    case "status":
      return { version: marker };
    case "health":
      return { marker, ok: true };
    case "models.list":
      return { models: [{ id: marker }] };
    case "cron.status":
      return { enabled: true, triggersEnabled: true, jobs: marker.length, nextWakeAtMs: null };
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

export function expectSnapshots(page: TestDebugPage, marker: string): void {
  expect(page.debugStatus).toEqual({ version: marker });
  expect(page.debugHealth).toEqual({ marker, ok: true });
  expect(page.debugModels).toEqual([{ id: marker }]);
  expect(page.debugAutomations).toEqual({
    enabled: true,
    triggersEnabled: true,
    jobs: marker.length,
    nextWakeAtMs: null,
  });
  expect(page.debugLanes).toEqual([expect.objectContaining({ lane: marker })]);
}

export function createProps(overrides: Partial<DebugProps> = {}): DebugProps {
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

export function normalizedText(element: Element | null | undefined): string | undefined {
  return element?.textContent?.replace(/\s+/gu, " ").trim();
}
