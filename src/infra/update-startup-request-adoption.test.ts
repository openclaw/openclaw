import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { UpdateCheckResult } from "./update-check.js";
import { createUpdateRun } from "./update-run-ledger.js";

const checkUpdateStatus = vi.hoisted(() =>
  vi.fn<typeof import("./update-check.js").checkUpdateStatus>(),
);
vi.mock("../version.js", async (original) => ({
  ...(await original<typeof import("../version.js")>()),
  VERSION: "2026.9.7",
}));
vi.mock("./update-check.js", async (original) => ({
  ...(await original<typeof import("./update-check.js")>()),
  checkUpdateStatus,
}));

it.each(["complete", "attached-close", "before-ready-close"])(
  "preserves early discovery through scheduler adoption: %s",
  async (outcome) => {
    const state = await createOpenClawTestState({ label: "update-request-adoption" });
    const startup = await import("./update-startup.js");
    const { createGatewayUpdateLifecycle } = await import("./update-check-lifecycle.js");
    const { createDeferredGatewayUpdateCheck } =
      await import("../gateway/server-startup-update-check.js");
    const { resolveGatewayUpdateAdmission } =
      await import("../gateway/server-methods/update-admission.js");
    const scheduler = createTestGatewayScheduler();
    startup.resetUpdateAvailableStateForTest(scheduler);
    const ready = createDeferred();
    const started = createDeferred<AbortSignal | undefined>();
    const probe = createDeferred<UpdateCheckResult>();
    const status: UpdateCheckResult = { root: null, installKind: "package", packageManager: "npm" };
    checkUpdateStatus.mockReset().mockImplementation(({ signal }) => {
      started.resolve(signal);
      return probe.promise;
    });
    const deferred = outcome === "before-ready-close";
    const lifecycle = createGatewayUpdateLifecycle(scheduler);
    const factory = vi.spyOn(startup, "createGatewayUpdateCheck");
    let owner: { stop(): Promise<void> } | undefined;
    if (deferred) {
      const waiting = createDeferredGatewayUpdateCheck({
        scheduler,
        getConfig: () => ({}),
        getPluginRegistry: () => undefined,
        log: { info: vi.fn(), warn: vi.fn() },
        isNixMode: false,
        broadcastToConnIds: vi.fn(),
        getClientConnIds: () => new Set(),
        waitForPostReadyWork: () => ready.promise,
      });
      waiting.start();
      owner = waiting;
    }
    const requests: Promise<unknown>[] = [
      startup.getUpdateEffectiveChannel(),
      deferred
        ? resolveGatewayUpdateAdmission(createUpdateRun({ trigger: "api" }).runId)
        : startup.initializeGatewayUpdateStatus(),
    ];
    try {
      const signal = await started.promise;
      if (!deferred) {
        const attached = startup.createGatewayUpdateCheck({
          lifecycle,
          getConfig: () => ({}),
          applyRemoteCatalogUpdate: async () => "unchanged",
          log: { info: vi.fn() },
          isNixMode: false,
        });
        owner = attached;
        expect(signal?.aborted).toBe(false);
        requests.push(attached.initialize());
      }
      if (outcome === "complete") {
        probe.resolve(status);
        await expect(requests[0]).resolves.toBe("stable");
        for (const request of requests.slice(1)) {
          await expect(request).resolves.toMatchObject({ status });
        }
      } else {
        let stopped = false;
        const stopping = owner!.stop().then(() => {
          stopped = true;
        });
        expect(signal?.aborted).toBe(true);
        await Promise.resolve();
        expect(stopped).toBe(false);
        if (deferred) {
          expect(factory).not.toHaveBeenCalled();
        }
        probe.resolve(status);
        await Promise.all([
          ...requests.map((request) =>
            expect(request).rejects.toMatchObject({ name: "AbortError" }),
          ),
          stopping,
        ]);
        expect(stopped).toBe(true);
        if (deferred) {
          expect(factory).not.toHaveBeenCalled();
        }
      }
      expect(checkUpdateStatus).toHaveBeenCalledTimes(deferred ? 2 : 1);
    } finally {
      probe.resolve(status);
      await Promise.allSettled([...requests, owner?.stop()]);
      factory.mockRestore();
      ready.resolve();
      startup.resetUpdateAvailableStateForTest(scheduler);
      closeOpenClawStateDatabaseForTest();
      await state.cleanup();
    }
  },
);
