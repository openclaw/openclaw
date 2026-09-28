import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { WorkerEnvironmentNodeTunnel } from "./environment-access.js";
import * as support from "./service.test-support.js";
import type { WorkerTunnelManager } from "./tunnel.js";
import { measureLaunchTurn } from "./worker-turn-launcher.test-support.js";

describe("worker environment startup authority", () => {
  support.setupWorkerEnvironmentServiceSuite();
  afterEach(() => vi.restoreAllMocks());

  it("does not start a tunnel after dispatch authority closes during build preparation", async () => {
    const prepared = createDeferred<typeof support.BUNDLE_ARTIFACT>();
    const preparing = createDeferred();
    support.testState.prepareInstallation = vi.fn(async () => {
      preparing.resolve();
      return await prepared.promise;
    });
    const environmentId = "worker-revoked-tunnel";
    await support.seedReady(environmentId, undefined, true);
    const tunnelManager = {
      status: () => "stopped" as const,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      stopAll: vi.fn(async () => {}),
    } as unknown as WorkerTunnelManager;
    const workerService = support.createService(support.createProvider(), { tunnelManager });
    let authorized = true;

    const starting = workerService.startTunnel({
      environmentId,
      ownerEpoch: 1,
      authorize: () => {
        if (!authorized) {
          throw new Error("session dispatch authority closed");
        }
      },
    });
    const rejected = expect(starting).rejects.toThrow("session dispatch authority closed");
    await preparing.promise;
    authorized = false;
    prepared.resolve(support.BUNDLE_ARTIFACT);

    await rejected;
    expect(tunnelManager.start).not.toHaveBeenCalled();
  });

  it.each([
    { executionMode: "worker-turn", revokeDuringPreparation: false },
    { executionMode: "remote-exec", revokeDuringPreparation: false },
    { executionMode: "remote-exec", revokeDuringPreparation: true },
  ] as const)(
    "checks $executionMode node ownership beyond worker credential expiry (revoke during preparation: $revokeDuringPreparation)",
    async ({ executionMode, revokeDuringPreparation }) => {
      const tunnelManager = {
        status: () => "stopped" as const,
        start: vi.fn(),
        stop: vi.fn(async () => {}),
        stopAll: vi.fn(async () => {}),
      } as unknown as WorkerTunnelManager;
      support.testState.config.cloudWorkers!.profiles!.development!.provider = "crabbox";
      const nodeHandle = {
        environmentId: "pending",
        ownerEpoch: 0,
        measureLaunchTurn,
        launchTurn: vi.fn(),
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: vi.fn(),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
        stop: vi.fn(async () => {}),
      };
      const nodeTunnelManager = {
        status: () => "stopped" as const,
        start: vi.fn(async (request: Parameters<WorkerEnvironmentNodeTunnel["start"]>[0]) => ({
          ...nodeHandle,
          environmentId: request.environmentId,
          ownerEpoch: request.ownerEpoch,
        })),
        stop: vi.fn(async () => {}),
        stopAll: vi.fn(async () => {}),
      };
      const workerService = support.createService(
        support.createProvider({
          supportedExecutionModes: ["worker-turn", "remote-exec"],
          id: "crabbox",
          provision: async () => ({
            leaseId: "cloud-lease",
            node: { deviceId: "device-1" },
          }),
        }),
        {
          tunnelManager,
          nodeTunnelManager,
          ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT),
        },
      );
      const environment = await workerService.createWithRequest({
        profileId: "development",
        idempotencyKey: "cloud-node-tunnel-gate",
        executionMode,
      });
      const credential = await workerService.attachSession({
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
        sessionId: "session-device",
      });
      const prepareInstallation = vi.mocked(support.testState.prepareInstallation);
      const prepareCallsBeforeTunnel = prepareInstallation.mock.calls.length;
      if (revokeDuringPreparation) {
        const preparing = createDeferred();
        const release = createDeferred<typeof support.BUNDLE_ARTIFACT>();
        prepareInstallation.mockImplementationOnce(async () => {
          preparing.resolve();
          return await release.promise;
        });
        const starting = workerService.startTunnel({
          environmentId: environment.environmentId,
          ownerEpoch: credential.ownerEpoch,
        });
        await preparing.promise;
        await support.testState.store.revokeEnvironmentCredential(environment.environmentId);
        release.resolve(support.BUNDLE_ARTIFACT);
        await expect(starting).rejects.toThrow("owner credential is not current");
        expect(nodeTunnelManager.start).not.toHaveBeenCalled();
        return;
      }
      support.testState.nowMs = credential.expiresAtMs + 1;
      let invocationCurrent = true;
      const authorize = () => {
        if (!invocationCurrent) {
          throw new Error("node startup invocation closed");
        }
      };

      await expect(
        workerService.startTunnel({
          environmentId: environment.environmentId,
          ownerEpoch: credential.ownerEpoch,
          authorize,
        }),
      ).resolves.toMatchObject({ environmentId: environment.environmentId });
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
      invocationCurrent = false;
      expect(() => nodeTunnelManager.start.mock.calls[0]![0].authorize?.()).toThrow(
        "node startup invocation closed",
      );
      await expect(
        workerService.startTunnel({
          environmentId: environment.environmentId,
          ownerEpoch: credential.ownerEpoch - 1,
        }),
      ).rejects.toThrow("owner credential is not current");
      await support.testState.store.revokeEnvironmentCredential(environment.environmentId);
      await expect(
        workerService.startTunnel({
          environmentId: environment.environmentId,
          ownerEpoch: credential.ownerEpoch,
        }),
      ).rejects.toThrow("owner credential is not current");
      expect(nodeTunnelManager.start).toHaveBeenCalledOnce();
    },
  );
});
