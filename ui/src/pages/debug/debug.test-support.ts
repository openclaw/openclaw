import { afterEach, beforeEach, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { cleanupSolid as cleanup } from "../../test-helpers/mount-solid.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";

export function createDebugApplicationContext(
  request: (method: string) => Promise<unknown>,
  phase: ApplicationGatewaySnapshot["phase"] = "connected",
): ApplicationContext {
  const client = { request } as unknown as GatewayBrowserClient;
  const gateway = {
    snapshot: {
      phase,
      client: phase === "connected" ? client : null,
      hello: gatewayHelloForMethods(["system.info", "manual.first", "manual.latest"]),
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

export function normalizedText(element: Element | null | undefined): string | undefined {
  return element?.textContent?.replace(/\s+/gu, " ").trim();
}

export function useDebugTestEnvironment() {
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
    cleanup();
    document.body.replaceChildren();
    await i18n.setLocale("en");
    vi.unstubAllGlobals();
  });
}
