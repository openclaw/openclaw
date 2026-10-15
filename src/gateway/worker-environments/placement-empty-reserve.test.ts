import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
  WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE } from "../../infra/node-runner-inventory.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import { completeWorkerNodeSetupForTest } from "./node-enrollment.test-support.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as support from "./service.test-support.js";

describe("empty reserve production lifecycle", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("refills after activation and reclaim, then claims through the next dispatch", async () => {
    const root = path.join(support.testState.root, "empty");
    await fs.mkdir(root);
    await requireGit(root, ["init", "--quiet", "-b", "main"]);
    await requireGit(root, [
      "-c",
      "user.name=Reserve Test",
      "-c",
      "user.email=reserve@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "--quiet",
      "-m",
      "empty",
    ]);
    const features = [
      WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE,
      WORKER_EXECUTION_AUTHORITY_PROTOCOL_FEATURE,
    ];
    vi.mocked(support.testState.prepareInstallation).mockResolvedValue({
      ...support.BUNDLE_ARTIFACT,
      protocolFeatures: features,
    });
    const clock = createGatewaySchedulerClock(support.testState.nowMs);
    const retentionEntered = createDeferredCore();
    const releaseRetention = createDeferredCore();
    let reserveReady = createDeferredCore();
    let consumedEnvironmentId: string | undefined;
    let artifactCalls = 0;
    let credentialSequence = 0;
    const warn = vi.fn();
    const provider = support.createProvider({
      requiresNodeEnrollment: true,
      provisionBeforeInstallation: true,
      supportedExecutionModes: ["worker-turn"],
      supportsProjectPreparation: () => true,
      resolvePreparationTarget: () => ({ machineClass: "small", platform: "linux" }),
      resolvePreparedIdleTimeoutMs: () => 3_600_000,
      provision: vi.fn(async (_profile, operationId, options) => {
        expect(options?.project).toBeUndefined();
        const enrollment = await options!.beginNodeEnrollment!();
        if (enrollment.mode !== "connect") {
          throw new Error("Expected node enrollment");
        }
        await completeWorkerNodeSetupForTest({
          baseDir: support.testState.root,
          store: support.testState.store,
          setupId: enrollment.setupId,
          deviceId: operationId,
          completedAtMs: support.testState.nowMs,
        });
        return { leaseId: operationId, node: { deviceId: operationId }, sharedHost: false };
      }),
    });
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const service = support.createService(provider, {
      scheduler: createTestGatewayScheduler(clock.clock),
      projectNamespace: "gateway",
      logger: { warn },
      generateWorkerCredential: () => `${support.CREDENTIAL}-${++credentialSequence}`,
      prepareNodeArtifacts: async () => {
        // Pause activation-driven retention after the initial dispatch admitted its artifacts.
        if (++artifactCalls > 1) {
          retentionEntered.resolve();
          await releaseRetention.promise;
        }
        return {
          artifacts: {
            nodeBootstrapSha256: support.NODE_BOOTSTRAP.sha256,
            enabledPluginIds: [...support.NODE_BOOTSTRAP.enabledPluginIds],
            workerBundleHash: support.BUNDLE_HASH,
            workerArchiveSha256: support.BUNDLE_ARTIFACT.tarballSha256,
            openclawVersion: support.BUNDLE_ARTIFACT.openclawVersion,
            protocolFeatures: features,
          },
          assertCurrent: () => {},
        };
      },
      prepareNodeEnrollment: async (record) => {
        const pending = await support.testState.store.ensureNodeEnrollment(record.environmentId);
        return {
          mode: "connect",
          setupId: pending.nodeSetupId!,
          setupCode: "synthetic-setup",
          displayName: "Reserve node",
          openclawVersion: support.NODE_BOOTSTRAP.openclawVersion,
          nodeBootstrap: support.NODE_BOOTSTRAP,
          waitForDeviceId: async () => record.provisionOperationId,
        };
      },
      ensureNodeWorkerBundle: async () => ({
        ...support.BOOTSTRAP_RECEIPT,
        protocolFeatures: features,
      }),
    });
    const unsubscribe = sessionChanges.subscribe(() => {
      if (
        support.testState.store
          .list()
          .some(
            (row) =>
              row.preparation?.consumedAtMs === null &&
              row.state === "ready" &&
              row.environmentId !== consumedEnvironmentId,
          )
      ) {
        reserveReady.resolve();
      }
    });
    try {
      const harness = await createHarness(support.testState.stateDb, placements, {
        environmentService: service,
        workspacePath: root,
      });
      bindDeviceWorkerAvailability(harness.environments, async (deviceId) => ({
        available: true,
        node: {
          nodeId: deviceId,
          connId: deviceId,
          pairingIdentity: "fixture",
          pairingGeneration: "fixture",
          clientId: GATEWAY_CLIENT_IDS.NODE_HOST,
          clientMode: GATEWAY_CLIENT_MODES.NODE,
          protocolFeature: NODE_WORKER_SUPERVISOR_PROTOCOL_FEATURE,
          commands: [],
          workerHost: {
            enabled: true,
            capacity: { total: 1, available: 1 },
            environmentSession: 1,
            capturedExecPolicy: true,
            promptContext: 1,
          },
        },
      }));
      vi.spyOn(harness.environments, "startTunnel").mockImplementation(
        async ({ environmentId, ownerEpoch }) => ({
          ...harness.tunnelHandle(ownerEpoch),
          environmentId,
        }),
      );
      await service.ready();
      service.start();
      const first = await harness.service.dispatch(REQUEST);
      expect(first.state).toBe("active");
      expect(support.testState.store.get(first.environmentId!)?.lastActivatedAtMs).toBe(1_000);
      await retentionEntered.promise;
      support.testState.nowMs += 90_000;
      await harness.service.reclaim(REQUEST);
      expect(support.testState.store.get(first.environmentId!)?.state).toBe("destroyed");
      await clock.advanceBy(90_000);
      releaseRetention.resolve();
      await reserveReady.promise;
      const reserve = support.testState.store
        .list()
        .find((row) => row.preparation && row.state === "ready")!;
      expect(reserve.profileSnapshot).toMatchObject({ runtimePreparation: { source: "empty" } });
      expect(reserve.attachedSessionIds).toEqual([]);
      const create = vi.spyOn(harness.environments, "createWithRequest");
      reserveReady = createDeferredCore();
      consumedEnvironmentId = reserve.environmentId;
      const second = await harness.service.dispatch({
        ...REQUEST,
        sessionId: "second",
        sessionKey: "agent:main:second",
      });
      expect(second.environmentId).toBe(reserve.environmentId);
      expect(create).not.toHaveBeenCalled();
      expect(support.testState.store.get(reserve.environmentId)?.preparation?.consumedAtMs).toBe(
        support.testState.nowMs,
      );
      await reserveReady.promise;
      expect(
        support.testState.store
          .list()
          .filter((row) => row.state === "ready" && row.preparation?.consumedAtMs === null),
      ).toHaveLength(1);
    } finally {
      releaseRetention.resolve();
      unsubscribe();
    }
  });
});
