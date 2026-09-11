import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { GatewayCronExitWatcherHandoff, GatewayCronState } from "./server-cron.js";
import type {
  GatewayHotReloadPublication,
  GatewayReloadHandlerParams,
} from "./server-reload-contracts.js";

const { buildGatewayCronService } = vi.hoisted(() => ({
  buildGatewayCronService: vi.fn<typeof import("./server-cron.js").buildGatewayCronService>(),
}));

vi.mock("./server-cron.js", () => ({ buildGatewayCronService }));

vi.mock("../agents/prepared-model-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/prepared-model-runtime.js")>()),
  markPreparedModelRuntimeSnapshotsStale: vi.fn(),
  rejectPendingPreparedModelRuntimeReplacement: vi.fn(),
  refreshPreparedModelRuntimeSnapshots: vi.fn(async () => {}),
}));

beforeEach(() => {
  // Each case needs a cold import to suspend the first requested cron rebuild.
  vi.resetModules();
  buildGatewayCronService.mockReset();
  vi.doMock("./server-cron.js", () => ({ buildGatewayCronService }));
});

afterEach(() => {
  vi.doMock("./server-cron.js", () => ({ buildGatewayCronService }));
});

function createCronState() {
  const cron = { start: vi.fn(async () => {}), stop: vi.fn() };
  const state: GatewayCronState = {
    cron: cron as unknown as GatewayCronState["cron"],
    storePath: "/tmp/cron.json",
    cronEnabled: true,
    reconcileExitWatchers: vi.fn(async () => {}),
    reconcileStreamWatchers: vi.fn(async () => {}),
    stopStreamWatchers: vi.fn(async () => {}),
    reconcileSystemJobs: vi.fn(async () => "converged" as const),
  };
  return { state, cron };
}

async function createFixture() {
  const { createGatewayReloadHandlers } = await import("./server-reload-hot.js");
  const { buildGatewayReloadPlan } = await import("./config-reload-plan.js");
  const { state: previous, cron: previousCron } = createCronState();
  const { state: next, cron: nextCron } = createCronState();
  buildGatewayCronService.mockReturnValue(next);
  let state: ReturnType<GatewayReloadHandlerParams["getState"]> = {
    hooksConfig: null,
    hookClientIpConfig: { trustedProxies: [], allowRealIpFallback: false },
    heartbeatRunner: { stop: vi.fn(), updateConfig: vi.fn() },
    cronState: previous,
  };
  const setState = vi.fn<GatewayReloadHandlerParams["setState"]>((value) => {
    state = value;
  });
  const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
  const params: GatewayReloadHandlerParams = {
    deps: {} as GatewayReloadHandlerParams["deps"],
    broadcast: vi.fn(),
    getState: () => state,
    setState,
    getPluginRegistry: vi.fn(),
    startChannel: vi.fn(async () => new Map()),
    stopChannel: vi.fn(async () => {}),
    releaseChannelRouteHandoffs: vi.fn(),
    pruneInactiveChannelAccountState: vi.fn(),
    reloadPlugins: vi.fn(async () => ({ activeChannels: new Set() })),
    logHooks: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    logChannels: { info: vi.fn(), error: vi.fn() },
    logCron: { error: vi.fn() },
    logReload: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    cronReconciliation: {
      arm: vi.fn(() => ({ complete: vi.fn(async () => {}) })),
      invalidate: vi.fn(),
    },
    requestRecoveryRestart,
  };
  const handlers = createGatewayReloadHandlers(params);
  const nextConfig: OpenClawConfig = { cron: { enabled: true } };
  const plan = buildGatewayReloadPlan(["cron.enabled"]);
  return {
    handlers,
    previous,
    previousCron,
    next,
    nextCron,
    nextConfig,
    plan,
    setState,
    requestRecoveryRestart,
    replace: () => createGatewayReloadHandlers(params),
  };
}

describe("cron reload loading", { concurrent: false }, () => {
  it("loads cron only when the reload plan requests its first rebuild", async () => {
    const fixture = await createFixture();
    const load = vi.fn(() => ({ buildGatewayCronService }));
    vi.doMock("./server-cron.js", load);
    try {
      await fixture.handlers.applyHotReload(
        { ...fixture.plan, restartCron: false, reconcileSystemJobs: false },
        fixture.nextConfig,
      );
      expect(load).not.toHaveBeenCalled();
      expect(buildGatewayCronService).not.toHaveBeenCalled();

      await fixture.handlers.applyHotReload(fixture.plan, fixture.nextConfig);
      expect(load).toHaveBeenCalledOnce();
      expect(buildGatewayCronService).toHaveBeenCalledOnce();
      expect(fixture.setState).toHaveBeenLastCalledWith(
        expect.objectContaining({ cronState: fixture.next }),
      );
      expect(fixture.previousCron.stop).toHaveBeenCalledOnce();
      expect(fixture.nextCron.start).toHaveBeenCalledOnce();
    } finally {
      fixture.handlers.stopRestartRetries();
    }
  });

  it.each(
    (["load", "handoff", "publication"] as const).flatMap((phase) =>
      (["stop", "replace", "supersede"] as const).map((action) => ({ phase, action })),
    ),
  )("rejects cron publication after $action during $phase", async ({ phase, action }) => {
    const fixture = await createFixture();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const hold = async () => {
      entered.resolve();
      await release.promise;
    };
    const previousHandoff: GatewayCronExitWatcherHandoff = {
      current: vi.fn(),
      adopt: vi.fn(),
      stopOwner: vi.fn(async () => {}),
    };
    const nextHandoff: GatewayCronExitWatcherHandoff = {
      current: vi.fn(),
      adopt: vi.fn(),
      stopOwner: vi.fn(async () => {}),
    };
    if (phase === "load") {
      vi.doMock("./server-cron.js", async () => {
        await hold();
        return { buildGatewayCronService };
      });
    } else if (phase === "handoff") {
      fixture.previous.prepareExitWatcherHandoff = async () => {
        await hold();
        return previousHandoff;
      };
      fixture.next.prepareExitWatcherHandoff = async () => nextHandoff;
    }
    let current = true;
    const publication: GatewayHotReloadPublication = {
      sourceConfig: fixture.nextConfig,
      isCurrent: () => current,
      publish: async (commit) => {
        if (phase === "publication") {
          await hold();
        }
        await commit();
      },
    };
    let replacement: ReturnType<typeof fixture.replace> | undefined;
    const reload = fixture.handlers.applyHotReload(fixture.plan, fixture.nextConfig, publication);
    const settled = reload.then(
      () => ({ status: "applied" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    try {
      // Observe the owning await, not a timer or an assumed import microtask count.
      expect(
        await Promise.race([entered.promise.then(() => "entered"), settled.then(() => "settled")]),
      ).toBe("entered");
      if (action === "stop") {
        fixture.handlers.stopRestartRetries();
      } else if (action === "replace") {
        replacement = fixture.replace();
      } else {
        current = false;
      }
      release.resolve();
      const result = await settled;
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.error).toMatchObject({
          name:
            action === "supersede"
              ? "GatewayConfigReloadSupersededError"
              : "GatewayHotReloadCancelledError",
        });
      }
      expect(buildGatewayCronService).toHaveBeenCalledTimes(phase === "load" ? 0 : 1);
      expect(fixture.setState).not.toHaveBeenCalled();
      expect(fixture.previousCron.stop).not.toHaveBeenCalled();
      expect(fixture.previous.stopStreamWatchers).not.toHaveBeenCalled();
      expect(fixture.nextCron.start).not.toHaveBeenCalled();
      expect(nextHandoff.adopt).not.toHaveBeenCalled();
      expect(previousHandoff.stopOwner).not.toHaveBeenCalled();
      expect(fixture.requestRecoveryRestart).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await settled;
      fixture.handlers.stopRestartRetries();
      replacement?.stopRestartRetries();
    }
  });

  it("returns the loader failure without publishing or retiring the current cron", async () => {
    const fixture = await createFixture();
    const failure = new Error("cron runtime load failed");
    vi.doMock("./server-cron.js", () => {
      throw failure;
    });
    try {
      // Vitest wraps mock factory failures and preserves the original error as cause.
      await expect(
        fixture.handlers.applyHotReload(fixture.plan, fixture.nextConfig),
      ).rejects.toSatisfy((error: unknown) => error instanceof Error && error.cause === failure);
      expect(buildGatewayCronService).not.toHaveBeenCalled();
      expect(fixture.setState).not.toHaveBeenCalled();
      expect(fixture.previousCron.stop).not.toHaveBeenCalled();
      expect(fixture.nextCron.start).not.toHaveBeenCalled();
      expect(fixture.requestRecoveryRestart).not.toHaveBeenCalled();
    } finally {
      fixture.handlers.stopRestartRetries();
    }
  });
});
