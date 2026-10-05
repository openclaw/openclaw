import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { readImageReserveProject } from "./image-reserve.js";
import { completeWorkerNodeSetupForTest } from "./node-enrollment.test-support.js";
import * as support from "./service.test-support.js";

describe("image-only prepared worker provisioning", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("admits a dedicated bundled node without registering a repository workspace", async () => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const deviceId = "image-reserve-node";
    const registerPreparedWorkspace = vi.fn();
    const provider = support.createProvider({
      requiresNodeEnrollment: true,
      provisionBeforeInstallation: true,
      supportedExecutionModes: ["worker-turn"],
      supportsProjectPreparation: () => true,
      resolvePreparationTarget: () => ({ machineClass: "small", platform: "linux" }),
      provision: async (_profile, _operationId, options) => {
        expect(options?.project).toBeUndefined();
        if (!options?.beginNodeEnrollment) {
          throw new Error("Node enrollment is unavailable");
        }
        const enrollment = await options.beginNodeEnrollment();
        if (enrollment.mode !== "connect") {
          throw new Error("Image reserve must use node enrollment");
        }
        await completeWorkerNodeSetupForTest({
          baseDir: support.testState.root,
          store: support.testState.store,
          setupId: enrollment.setupId,
          deviceId,
          completedAtMs: support.testState.nowMs,
        });
        return {
          leaseId: "lease-image-reserve",
          node: { deviceId: await enrollment.waitForDeviceId() },
          sharedHost: false,
        };
      },
    });
    const service = support.createService(provider, {
      projectNamespace: "gateway",
      prepareNodeArtifacts: async () => ({
        artifacts: {
          nodeBootstrapSha256: support.NODE_BOOTSTRAP.sha256,
          enabledPluginIds: [...support.NODE_BOOTSTRAP.enabledPluginIds],
          workerBundleHash: support.BUNDLE_HASH,
          workerArchiveSha256: support.BUNDLE_ARTIFACT.tarballSha256,
          openclawVersion: support.BUNDLE_ARTIFACT.openclawVersion,
          protocolFeatures: [...support.BUNDLE_ARTIFACT.protocolFeatures],
        },
        assertCurrent: () => {},
      }),
      prepareNodeEnrollment: async (record) => {
        const pending = await support.testState.store.ensureNodeEnrollment(record.environmentId);
        return {
          mode: "connect",
          setupId: expectDefined(pending.nodeSetupId, "pending node enrollment"),
          setupCode: "synthetic-setup",
          displayName: "Image reserve node",
          openclawVersion: support.NODE_BOOTSTRAP.openclawVersion,
          nodeBootstrap: support.NODE_BOOTSTRAP,
          waitForDeviceId: async () => deviceId,
        };
      },
      ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT),
      registerPreparedWorkspace,
    });
    const admittedIntent = await service.prepareProjectIntent("development", {
      imageReserve: true,
      executionMode: "worker-turn",
    });
    expect(readImageReserveProject(admittedIntent.profileSnapshot.project)).toBeDefined();
    const environment = await service.createWithRequest({
      profileId: "development",
      idempotencyKey: "image-reserve",
      executionMode: "worker-turn",
      admittedIntent,
    });
    expect(environment.state).toBe("ready");
    expect(environment.sharedHost).toBe(false);
    expect(readImageReserveProject(environment.profileSnapshot.project)).toBeDefined();
    expect(registerPreparedWorkspace).not.toHaveBeenCalled();
  });
});
