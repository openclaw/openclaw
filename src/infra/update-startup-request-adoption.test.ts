import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { UpdateCheckResult } from "./update-check.js";
import { createUpdateRun } from "./update-run-ledger.js";

const checkUpdateStatus = vi.hoisted(() =>
  vi.fn<typeof import("./update-check.js").checkUpdateStatus>(),
);

vi.mock("./update-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-check.js")>()),
  checkUpdateStatus,
}));

it.each(["complete", "close"] as const)(
  "preserves early status and update admission discovery when the scheduler attaches (%s)",
  async (outcome) => {
    const state = await createOpenClawTestState({ label: "update-request-adoption" });
    const {
      createGatewayUpdateCheck,
      getUpdateEffectiveChannel,
      initializeGatewayUpdateStatus,
      resetUpdateAvailableStateForTest,
    } = await import("./update-startup.js");
    resetUpdateAvailableStateForTest();
    const { createGatewayUpdateLifecycle } = await import("./update-check-lifecycle.js");
    const lifecycle = createGatewayUpdateLifecycle();
    const started = createDeferred<AbortSignal | undefined>();
    const probe = createDeferred<UpdateCheckResult>();
    const status: UpdateCheckResult = { root: null, installKind: "package", packageManager: "npm" };
    checkUpdateStatus.mockReset().mockImplementation(({ signal }) => {
      started.resolve(signal);
      return probe.promise;
    });
    const channelRequest = getUpdateEffectiveChannel();
    const admissionRequest = initializeGatewayUpdateStatus();
    let owner: ReturnType<typeof createGatewayUpdateCheck> | undefined;
    let initialization: ReturnType<typeof initializeGatewayUpdateStatus> | undefined;
    try {
      const signal = await started.promise;
      owner = createGatewayUpdateCheck({
        lifecycle,
        getConfig: () => ({}),
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
      resetUpdateAvailableStateForTest();
      closeOpenClawStateDatabaseForTest();
      await state.cleanup();
    }
  },
);

it("aborts and joins early update requests before the post-ready scheduler loads", async () => {
  const state = await createOpenClawTestState({ label: "update-request-before-ready" });
  const { createDeferredGatewayUpdateCheck } =
    await import("../gateway/server-startup-update-check.js");
  const { resolveGatewayUpdateAdmission } =
    await import("../gateway/server-methods/update-admission.js");
  const { createGatewayUpdateCheck, getUpdateEffectiveChannel, resetUpdateAvailableStateForTest } =
    await import("./update-startup.js");
  resetUpdateAvailableStateForTest();
  const ready = createDeferred();
  const started = createDeferred<AbortSignal | undefined>();
  const probe = createDeferred<UpdateCheckResult>();
  const status: UpdateCheckResult = { root: null, installKind: "package", packageManager: "npm" };
  checkUpdateStatus.mockReset().mockImplementation(({ signal }) => {
    started.resolve(signal);
    return probe.promise;
  });
  const factory = vi.fn(createGatewayUpdateCheck);
  const owner = createDeferredGatewayUpdateCheck({
    createUpdateCheck: factory,
    getConfig: () => ({}),
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
    expect(results).toEqual([
      { status: "rejected", reason: expect.objectContaining({ name: "AbortError" }) },
      { status: "rejected", reason: expect.objectContaining({ name: "AbortError" }) },
    ]);
    await stopping;
    expect(stopped).toBe(true);
    expect(checkUpdateStatus).toHaveBeenCalledTimes(2);
    expect(factory).not.toHaveBeenCalled();
  } finally {
    probe.resolve(status);
    await requests;
    await (stopping ?? owner.stop());
    ready.resolve();
    resetUpdateAvailableStateForTest();
    closeOpenClawStateDatabaseForTest();
    await state.cleanup();
  }
});
