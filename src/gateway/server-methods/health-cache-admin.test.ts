import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerLegacyContextEngine } from "../../context-engine/legacy.registration.js";
import {
  captureContextEngineRegistryStateForTests,
  resetContextEngineRuntimeQuarantineForTests,
} from "../../context-engine/registry.test-support.js";

let healthHandlers: typeof import("./health.js").healthHandlers;

function createHealthSnapshot<T extends Record<string, unknown>>(overrides: T) {
  return {
    ok: true,
    ts: Date.now(),
    durationMs: 1,
    channels: {},
    channelOrder: [] as string[],
    channelLabels: {} as Record<string, string>,
    heartbeatSeconds: 0,
    defaultAgentId: "main",
    agents: [],
    sessions: { path: "/tmp/sessions.json", count: 0, recent: [] },
    ...overrides,
  };
}

async function requestHealthSnapshot(params: {
  cached: Record<string, unknown> | null;
  fresh?: Record<string, unknown>;
  scopes?: string[];
}) {
  const respond = vi.fn();
  const refreshHealthSnapshot = vi.fn().mockResolvedValue(params.fresh ?? params.cached);
  await expectDefined(healthHandlers.health, "healthHandlers.health test invariant").call(
    healthHandlers,
    {
      req: {} as never,
      params: {} as never,
      respond: respond as never,
      context: {
        getHealthCache: () => params.cached,
        refreshHealthSnapshot,
        getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
        logHealth: { error: vi.fn() },
      } as never,
      client: {
        connect: { role: "operator", scopes: params.scopes ?? ["operator.read"] },
      } as never,
      isWebchatConnect: () => false,
    },
  );
  return { respond, refreshHealthSnapshot };
}

describe("gateway healthHandlers.health admin cache", () => {
  let restoreContextEngineRegistryState: () => void;

  beforeAll(async () => {
    ({ healthHandlers } = await import("./health.js"));
  });

  beforeEach(() => {
    restoreContextEngineRegistryState = captureContextEngineRegistryStateForTests();
    registerLegacyContextEngine();
    resetContextEngineRuntimeQuarantineForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreContextEngineRegistryState();
  });

  it("does not serve a public cache to admin health requests", async () => {
    const cached = createHealthSnapshot({});
    const fresh = createHealthSnapshot({ adminOnly: true });
    const { respond, refreshHealthSnapshot } = await requestHealthSnapshot({
      cached,
      fresh,
      scopes: ["operator.admin"],
    });

    expect(refreshHealthSnapshot).toHaveBeenCalledWith({
      probe: false,
      includeSensitive: true,
    });
    expect(respond).toHaveBeenCalledWith(true, fresh, undefined);
  });
});
