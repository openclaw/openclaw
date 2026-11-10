import "../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { GatewayCronExitWatcherHandoff, GatewayCronState } from "./server-cron-contract.js";
import type {
  GatewayHotReloadPublication,
  GatewayReloadHandlerParams,
} from "./server-reload-contracts.js";
import {
  createDefaultGatewayReloadState,
  createHotReloadHandlerTestParams,
  createTestCronState,
  makePluginReloadResult,
} from "./server-reload-handlers.config.test-support.js";

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

afterEach(async () => {
  const { clearRuntimeConfigSnapshot } = await import("../config/runtime-snapshot.js");
  clearRuntimeConfigSnapshot();
  vi.doMock("./server-cron.js", () => ({ buildGatewayCronService }));
});

function createCronState() {
  const cron = { start: vi.fn(async () => {}), stop: vi.fn() };
  const state = createTestCronState({
    cron: cron as unknown as GatewayCronState["cron"],
    cronEnabled: true,
  });
  return { state, cron };
}

async function createFixture() {
  const { setRuntimeConfigSnapshot } = await import("../config/runtime-snapshot.js");
  setRuntimeConfigSnapshot({});
  const { createGatewayReloadHandlers } = await import("./server-reload-hot.js");
  const { buildGatewayReloadPlan } = await import("./config-reload-plan.js");
  const { state: previous, cron: previousCron } = createCronState();
  const { state: next, cron: nextCron } = createCronState();
  buildGatewayCronService.mockReturnValue(next);
  let state = createDefaultGatewayReloadState({
    hooksConfig: null,
    hookClientIpConfig: { trustedProxies: [], allowRealIpFallback: false },
    cronState: previous,
  });
  const setState = vi.fn<GatewayReloadHandlerParams["setState"]>((value) => {
    state = value;
  });
  const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
  const params = createHotReloadHandlerTestParams({
    scheduler: createTestGatewayScheduler(),
    deps: {} as GatewayReloadHandlerParams["deps"],
    getState: () => state,
    setState,
    requestRecoveryRestart,
  });
  const handlers = createGatewayReloadHandlers(params);
  const nextConfig: OpenClawConfig = { cron: { enabled: true } };
  const plan = buildGatewayReloadPlan(["cron.enabled"]);
  return {
    [Symbol.dispose]: () => handlers.stopRestartRetries(),
    handlers,
    previous,
    previousCron,
    next,
    nextCron,
    nextConfig,
    plan,
    setState,
    requestRecoveryRestart,
    reloadPlugins: vi.mocked(params.reloadPlugins),
    replace: () => createGatewayReloadHandlers(params),
    expectUnpublished: () => {
      for (const mock of [setState, previousCron.stop, nextCron.start, requestRecoveryRestart]) {
        expect(mock).not.toHaveBeenCalled();
      }
    },
  };
}

describe("cron reload loading", { concurrent: false }, () => {
  it("loads cron only when its configuration requires a rebuild", async () => {
    const load = vi.fn(() => ({ buildGatewayCronService }));
    vi.doMock("./server-cron.js", load);
    using fixture = await createFixture();
    await fixture.handlers.applyHotReload(
      { ...fixture.plan, restartCron: false },
      fixture.nextConfig,
    );
    expect(load).not.toHaveBeenCalled();
    expect(buildGatewayCronService).not.toHaveBeenCalled();
    await expect(fixture.handlers.applyHotReload(fixture.plan, fixture.nextConfig)).resolves.toBe(
      "applied",
    );
    expect(fixture.setState).toHaveBeenLastCalledWith(
      expect.objectContaining({ cronState: fixture.next }),
    );
    expect(fixture.nextCron.start).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledOnce();
    expect(buildGatewayCronService).toHaveBeenCalledOnce();
    expect(fixture.previousCron.stop).toHaveBeenCalledOnce();
  });

  // Each await rechecks the same ownership guard; cover every cause and await point.
  it.each([
    { phase: "load", action: "stop", plugins: false },
    { phase: "handoff", action: "replace", plugins: false },
    { phase: "publication", action: "supersede", plugins: false },
    { phase: "publication", action: "supersede", plugins: true },
  ] as const)(
    "rejects cron publication after $action during $phase (plugins: $plugins)",
    async ({ phase, action, plugins }) => {
      using fixture = await createFixture();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const hold = async () => {
        entered.resolve();
        await release.promise;
      };
      const handoff = (): GatewayCronExitWatcherHandoff => ({
        current: vi.fn(),
        adopt: vi.fn(),
        stopOwner: vi.fn(async () => {}),
      });
      const previousHandoff = handoff();
      const nextHandoff = handoff();
      const publishPluginRuntime = vi.fn();
      if (plugins) {
        fixture.reloadPlugins.mockImplementationOnce(async ({ commitRuntime }) => {
          await commitRuntime({ publish: publishPluginRuntime });
          return makePluginReloadResult();
        });
      }
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
      const reload = fixture.handlers.applyHotReload(
        { ...fixture.plan, reloadPlugins: plugins },
        fixture.nextConfig,
        publication,
      );
      const settled = reload.then(
        () => undefined,
        (error: unknown) => error,
      );
      await using _ = {
        [Symbol.asyncDispose]: async () => {
          release.resolve();
          await settled;
          replacement?.stopRestartRetries();
        },
      };
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
      expect(await settled).toMatchObject({
        name:
          action === "supersede"
            ? "GatewayConfigReloadSupersededError"
            : "GatewayHotReloadCancelledError",
      });
      expect(buildGatewayCronService).toHaveBeenCalledTimes(phase === "load" ? 0 : 1);
      fixture.expectUnpublished();
      expect(publishPluginRuntime).not.toHaveBeenCalled();
      expect(fixture.previous.stopStreamWatchers).not.toHaveBeenCalled();
      expect(nextHandoff.adopt).not.toHaveBeenCalled();
      expect(previousHandoff.stopOwner).not.toHaveBeenCalled();
    },
  );

  it("returns the loader failure without publishing or retiring the current cron", async () => {
    using fixture = await createFixture();
    const failure = new Error("cron runtime load failed");
    vi.doMock("./server-cron.js", () => {
      throw failure;
    });
    // Vitest wraps mock factory failures and preserves the original error as cause.
    await expect(
      fixture.handlers.applyHotReload(fixture.plan, fixture.nextConfig),
    ).rejects.toSatisfy((error: unknown) => error instanceof Error && error.cause === failure);
    expect(buildGatewayCronService).not.toHaveBeenCalled();
    fixture.expectUnpublished();
  });
});
