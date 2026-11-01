import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { createGatewayKernel } from "./server-kernel.js";
import * as fixture from "./server-startup-state.test-support.js";

it("retains shutdown dependencies after public close failure until the kernel retries", async () => {
  const port = await getFreePort();
  const state = await fixture.createGatewayStartupTestState("gateway-sidecar-retention");
  const token = "gateway-sidecar-retention-token";
  const dependencyStopEntered = createDeferred();
  const stopError = new Error("remote worker stop failed");
  let failStop = true;
  let kernel: Awaited<ReturnType<typeof createGatewayKernel>> | undefined;
  let closing: Promise<unknown> | undefined;
  let cleanupComplete = false;
  const createKernel = createGatewayKernel;
  vi.spyOn(await import("./server-kernel.js"), "createGatewayKernel").mockImplementation(
    async (...args) => {
      kernel = await createKernel(...args);
      return kernel;
    },
  );
  const stopGate = fixture.createStartupGate(() => {
    if (failStop) {
      throw stopError;
    }
  });
  const lateStopGate = fixture.createStartupGate();
  const sidecar = { stop: vi.fn(stopGate.run) };
  const lateSidecar = { stop: vi.fn(lateStopGate.run) };
  try {
    await state.writeConfig({
      gateway: fixture.gatewayStartupTestConfig(port, token),
    });
    state.applyEnv();
    const options = fixture.gatewayStartupTestOptions(token);
    const { startGatewayServerCore } = await import("./server-start.js");
    const server = await startGatewayServerCore(port, options);
    await server.startupSettled;
    const activeKernel = expectDefined(kernel, "the real Gateway kernel");
    activeKernel.registerConnectionDependentSidecars(sidecar);
    const closeTransport = vi.fn(() => releaseConnection());
    const releaseConnection = activeKernel.connectionWork.registerConnection(closeTransport);
    const dependencyStop = vi.fn(async () => dependencyStopEntered.resolve());
    activeKernel.registerGatewayLifetimeSidecars({ stop: dependencyStop });
    const terminalDispose = vi.spyOn(activeKernel.terminalSessions, "disposeAll");
    const closePrelude = vi.spyOn(activeKernel.watchNodeHttpRuntime, "close");
    const gatewayStop = vi.spyOn(activeKernel.shutdownRuntime, "runGlobalGatewayStopSafely");
    const secrets = getActiveSecretsRuntimeConfigSnapshot();
    expect(secrets).not.toBeNull();
    closing = server.close().catch((error: unknown) => error);
    await stopGate.entered;
    activeKernel.registerConnectionDependentSidecars(lateSidecar);
    expect(closeTransport).not.toHaveBeenCalled();
    stopGate.release();
    await lateStopGate.entered;
    expect(closeTransport).not.toHaveBeenCalled();
    lateStopGate.release();
    // Observe the failed owner's boundary without waiting for a later teardown stall.
    await Promise.race([closing, dependencyStopEntered.promise]);
    expect(closeTransport).not.toHaveBeenCalled();
    expect(dependencyStop).not.toHaveBeenCalled();
    expect(terminalDispose).not.toHaveBeenCalled();
    expect(closePrelude).not.toHaveBeenCalled();
    expect(gatewayStop).not.toHaveBeenCalled();
    expect(getActiveSecretsRuntimeConfigSnapshot()).toEqual(secrets);
    expect(await closing).toMatchObject({ errors: [{ cause: stopError }] });
    expect(sidecar.stop).toHaveBeenCalledOnce();
    expect(lateSidecar.stop).toHaveBeenCalledOnce();
    // The public close retains its failure; only the retained kernel owner may retry.
    failStop = false;
    await activeKernel.closeOnStartupFailure();
    cleanupComplete = true;
    expect(closeTransport).toHaveBeenCalledOnce();
    expect(dependencyStop).toHaveBeenCalledOnce();
    expect(sidecar.stop).toHaveBeenCalledTimes(2);
  } finally {
    // Join the original failure before changing its fault or releasing fixture state.
    stopGate.release();
    lateStopGate.release();
    try {
      await closing;
      failStop = false;
      if (kernel && !cleanupComplete) {
        await kernel.closeOnStartupFailure();
      }
      if (kernel) {
        await state.cleanup();
      }
    } finally {
      vi.restoreAllMocks();
    }
  }
});
import { expectDefined } from "@openclaw/normalization-core/expect";
