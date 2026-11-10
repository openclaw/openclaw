import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { WorkerEnvironmentNodeTunnel } from "./environment-access.js";
import { createStoppedTunnelManager } from "./environment-access.test-support.js";
import * as support from "./service.test-support.js";
import { measureLaunchTurn, readLaunchToolNames } from "./worker-turn-launcher.test-support.js";

support.setupWorkerEnvironmentServiceSuite();
afterEach(() => vi.restoreAllMocks());

it.each([
  ["ssh", "dispatch"],
  ["worker-turn", "current"],
  ["remote-exec", "current"],
  ["remote-exec", "credential"],
] as const)("checks %s startup authority: %s", async (executionMode, boundary) => {
  const tunnelManager = createStoppedTunnelManager();
  const nodeTunnelManager = {
    status: () => "stopped" as const,
    observeProcesses: vi.fn(async () => {
      throw new Error("Process observation is not configured in this fixture");
    }),
    start: vi.fn(async (request: Parameters<WorkerEnvironmentNodeTunnel["start"]>[0]) => ({
      environmentId: request.environmentId,
      ownerEpoch: request.ownerEpoch,
      measureLaunchTurn,
      readLaunchToolNames,
      launchTurn: vi.fn(),
      runWorkspaceCommand: vi.fn(),
      quiesceWorkspace: vi.fn(),
      syncWorkspace: vi.fn(),
      reconcileWorkspace: vi.fn(),
      stop: vi.fn(async () => {}),
    })),
    stop: vi.fn(async () => {}),
    stopAll: vi.fn(async () => {}),
    beginClose: vi.fn(),
  };
  const node = executionMode !== "ssh";
  const provider = support.createProvider();
  if (node) {
    support.testState.config.cloudWorkers!.profiles!.development!.provider = "crabbox";
    provider.id = "crabbox";
    provider.supportedExecutionModes = ["worker-turn", "remote-exec"];
    provider.provision = async () => ({ leaseId: "cloud-lease", node: { deviceId: "device-1" } });
  }
  const workerService = support.createService(provider, {
    tunnelManager,
    nodeTunnelManager,
    ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT),
  });
  const environment =
    executionMode === "ssh"
      ? await support.seedReady("worker-revoked-tunnel", undefined, true)
      : await workerService.createWithRequest({
          profileId: "development",
          idempotencyKey: "cloud-node-tunnel-gate",
          executionMode,
        });
  const credential = node
    ? await workerService.attachSession({
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
        sessionId: "session-device",
      })
    : support.testState.store.getCredential(environment.environmentId);
  if (!credential) {
    throw new Error("missing startup credential fixture");
  }
  const target = { environmentId: environment.environmentId, ownerEpoch: credential.ownerEpoch };
  const start = (overrides: Partial<Parameters<typeof workerService.startTunnel>[0]> = {}) =>
    workerService.startTunnel({ ...target, ...overrides });
  const revoke = () => support.testState.store.revokeEnvironmentCredential(target.environmentId);
  const controller = new AbortController();
  const authorize = () => controller.signal.throwIfAborted();
  const closed = new Error("startup invocation closed");
  const prepareInstallation = vi.mocked(support.testState.prepareInstallation);
  const prepareCallsBeforeTunnel = prepareInstallation.mock.calls.length;

  if (boundary !== "current") {
    const preparing = createDeferred();
    const release = createDeferred<typeof support.BUNDLE_ARTIFACT>();
    prepareInstallation.mockImplementationOnce(async () => {
      preparing.resolve();
      return await release.promise;
    });
    const rejected = expect(start({ authorize })).rejects.toThrow(
      boundary === "dispatch" ? closed.message : "owner credential is not current",
    );
    await preparing.promise;
    if (boundary === "dispatch") {
      controller.abort(closed);
    } else {
      await revoke();
    }
    release.resolve(support.BUNDLE_ARTIFACT);
    await rejected;
    expect(tunnelManager.start).not.toHaveBeenCalled();
    expect(nodeTunnelManager.start).not.toHaveBeenCalled();
    return;
  }

  support.testState.nowMs = credential.expiresAtMs + 1;
  await expect(start({ authorize })).resolves.toMatchObject({
    environmentId: target.environmentId,
  });
  expect(tunnelManager.start).not.toHaveBeenCalled();
  expect(prepareInstallation).toHaveBeenCalledTimes(prepareCallsBeforeTunnel + 1);
  expect(nodeTunnelManager.start).toHaveBeenCalledWith(
    expect.objectContaining({
      executionMode,
      deviceId: "device-1",
      sessionId: "session-device",
      expectedBuild: expect.objectContaining({ bundleHash: support.BUNDLE_HASH }),
      authorize,
    }),
  );
  controller.abort(closed);
  expect(() => nodeTunnelManager.start.mock.calls[0]![0].authorize?.()).toThrow(closed.message);
  await expect(start({ ownerEpoch: credential.ownerEpoch - 1 })).rejects.toThrow(
    "owner credential is not current",
  );
  await revoke();
  await expect(start()).rejects.toThrow("owner credential is not current");
  expect(nodeTunnelManager.start).toHaveBeenCalledOnce();
});
