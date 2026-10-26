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

vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  VERSION: "2026.9.7",
}));

vi.mock("./update-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-check.js")>()),
  checkUpdateStatus,
}));

async function fixture(label: string) {
  const state = await createOpenClawTestState({ label });
  const startup = await import("./update-startup.js");
  const scheduler = createTestGatewayScheduler();
  startup.resetUpdateAvailableStateForTest(scheduler);
  const started = createDeferred<AbortSignal | undefined>();
  const probe = createDeferred<UpdateCheckResult>();
  const status: UpdateCheckResult = { root: null, installKind: "package", packageManager: "npm" };
  checkUpdateStatus.mockReset().mockImplementation(({ signal }) => {
    started.resolve(signal);
    return probe.promise;
  });
  return {
    startup,
    scheduler,
    started,
    probe,
    status,
    async cleanup() {
      startup.resetUpdateAvailableStateForTest(scheduler);
      closeOpenClawStateDatabaseForTest();
      await state.cleanup();
    },
  };
}

it.each(["complete", "close"] as const)(
  "preserves early status and update admission discovery when the scheduler attaches (%s)",
  async (outcome) => {
    const { startup, scheduler, started, probe, status, cleanup } =
      await fixture("update-request-adoption");
    const { createGatewayUpdateCheck, getUpdateEffectiveChannel, initializeGatewayUpdateStatus } =
      startup;
    const { createGatewayUpdateLifecycle } = await import("./update-check-lifecycle.js");
    const lifecycle = createGatewayUpdateLifecycle(scheduler);
    const channelRequest = getUpdateEffectiveChannel();
    const admissionRequest = initializeGatewayUpdateStatus();
    let owner: ReturnType<typeof createGatewayUpdateCheck> | undefined;
    let initialization: ReturnType<typeof initializeGatewayUpdateStatus> | undefined;
    try {
      const signal = await started.promise;
      owner = createGatewayUpdateCheck({
        lifecycle,
        getConfig: () => ({}),
        applyRemoteCatalogUpdate: async () => "unchanged",
        log: { info: vi.fn() },
        isNixMode: false,
      });
      expect(signal?.aborted).toBe(false);
      initialization = owner.initialize();
      if (outcome === "close") {
        let stopped = false;
        const stopping = owner.stop().then(() => {
          stopped = true;
        });
        expect(signal?.aborted).toBe(true);
        await Promise.resolve();
        expect(stopped).toBe(false);
        probe.resolve(status);
        await Promise.all([
          expect(channelRequest).rejects.toMatchObject({ name: "AbortError" }),
          expect(admissionRequest).rejects.toMatchObject({ name: "AbortError" }),
          expect(initialization).rejects.toMatchObject({ name: "AbortError" }),
          stopping,
        ]);
        expect(stopped).toBe(true);
      } else {
        probe.resolve(status);
        await expect(channelRequest).resolves.toBe("stable");
        await expect(admissionRequest).resolves.toMatchObject({ status });
        await expect(initialization).resolves.toMatchObject({ status });
      }
      expect(checkUpdateStatus).toHaveBeenCalledOnce();
    } finally {
      probe.resolve(status);
      await Promise.allSettled([channelRequest, admissionRequest, initialization, owner?.stop()]);
      await cleanup();
    }
  },
);

it("aborts and joins early update requests before the post-ready scheduler loads", async () => {
  const { startup, scheduler, started, probe, status, cleanup } = await fixture(
    "update-request-before-ready",
  );
  const { createDeferredGatewayUpdateCheck } =
    await import("../gateway/server-startup-update-check.js");
  const { resolveGatewayUpdateAdmission } =
    await import("../gateway/server-methods/update-admission.js");
  const { getUpdateEffectiveChannel } = startup;
  const ready = createDeferred();
  const factory = vi.spyOn(startup, "createGatewayUpdateCheck");
  const owner = createDeferredGatewayUpdateCheck({
    scheduler,
    getConfig: () => ({}),
    getPluginRegistry: () => undefined,
    log: { info: vi.fn(), warn: vi.fn() },
    isNixMode: false,
    broadcastToConnIds: vi.fn(),
    getClientConnIds: () => new Set(),
    waitForPostReadyWork: () => ready.promise,
  });
  owner.start();
  const requests = Promise.allSettled([
    getUpdateEffectiveChannel(),
    resolveGatewayUpdateAdmission(createUpdateRun({ trigger: "api" }).runId),
  ]);
  let stopping: Promise<void> | undefined;
  try {
    const signal = await started.promise;
    let stopped = false;
    stopping = owner.stop().then(() => {
      stopped = true;
    });
    expect(signal?.aborted).toBe(true);
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(factory).not.toHaveBeenCalled();
    probe.resolve(status);
    const results = await requests;
    const aborted = { status: "rejected", reason: expect.objectContaining({ name: "AbortError" }) };
    expect(results).toEqual([aborted, aborted]);
    await stopping;
    expect(stopped).toBe(true);
    expect(checkUpdateStatus).toHaveBeenCalledTimes(2);
    expect(factory).not.toHaveBeenCalled();
  } finally {
    probe.resolve(status);
    await requests;
    await (stopping ?? owner.stop());
    factory.mockRestore();
    ready.resolve();
    await cleanup();
  }
});
