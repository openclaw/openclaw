import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import { completeWorkerNodeSetupForTest } from "./node-enrollment.test-support.js";
import { createNodeWorkerBundleTestNode } from "./node-worker-bundle.test-support.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { WORKER_PROTOCOL_FEATURES } from "./placement-lifecycle.test-support.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import {
  nodeArtifacts,
  pendingNodeEnrollment,
  repository,
} from "./provider-lifecycle.test-support.js";
import * as repositoryAdmission from "./repository-project-admission.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import * as support from "./service.test-support.js";
import { stageSessionRepositoryCheckpoint } from "./session-repository-checkpoints.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";

describe("runtime image reserve repository dispatch", () => {
  support.setupWorkerEnvironmentServiceSuite((config) => {
    config.gateway = { repositoryIntegration: "image-policy" };
  });
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function fixture(reserve: boolean) {
    vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
    const registry = createTestPluginRegistry();
    const record = createPluginRecord({
      id: "image-policy",
      source: "fixture",
      origin: "workspace",
      enabled: true,
      configSchema: false,
    });
    record.contracts = { repositoryIntegrations: ["repository"] };
    registry.registry.plugins.push(record);
    registry.createApi(record, { config: support.testState.config }).registerRepositoryIntegration({
      version: 1,
      preparedCapacity: "image",
      resolveConnectionIdentity: () => undefined,
      withIdentity: async (context, run) =>
        run({
          env: context.env,
          assertCurrent: context.assertCurrent,
          readNativeCredential: async () => undefined,
        }),
    });
    setActivePluginRegistry(registry.registry);
    const features = [...WORKER_PROTOCOL_FEATURES];
    const receipt = { ...support.BOOTSTRAP_RECEIPT, protocolFeatures: features };
    vi.mocked(support.testState.prepareInstallation).mockResolvedValue({
      ...support.BUNDLE_ARTIFACT,
      protocolFeatures: features,
    });
    const provider = support.createProvider({
      supportedExecutionModes: ["worker-turn"],
      requiresNodeEnrollment: true,
      supportsProjectPreparation: () => true,
      resolvePreparationTarget: () => ({ machineClass: "small", platform: "linux" }),
      provision: vi.fn(async (_profile, _operationId, options) => {
        expect(options?.project).toBeUndefined();
        const enrollment = await options!.beginNodeEnrollment!();
        if (enrollment.mode !== "connect") {
          throw new Error("Expected image enrollment");
        }
        await completeWorkerNodeSetupForTest({
          baseDir: support.testState.root,
          store: support.testState.store,
          setupId: enrollment.setupId,
          deviceId: "image-node",
          completedAtMs: support.testState.nowMs,
        });
        return { leaseId: "image-lease", node: { deviceId: "image-node" }, sharedHost: false };
      }),
    });
    const prepareNodeArtifacts = vi.fn(async () => ({
      ...nodeArtifacts(),
      artifacts: { ...nodeArtifacts().artifacts, protocolFeatures: features },
    }));
    const service = support.createService(provider, {
      projectNamespace: "image-dispatch",
      prepareNodeArtifacts,
      prepareNodeEnrollment: (environment: Parameters<typeof pendingNodeEnrollment>[0]) =>
        pendingNodeEnrollment(environment, async () => "image-node"),
      ensureNodeWorkerBundle: async () => receipt,
    });
    const store = support.testState.store;
    const environmentId = reserve
      ? "runtime-image-spare"
      : deriveEnvironmentIntent("image-dispatch").environmentId;
    if (reserve) {
      const intent = await service.prepareProjectIntent("development", {
        imageReserve: true,
        executionMode: "worker-turn",
      });
      const key = intent.profileSnapshot.runtimePreparation!.key;
      await store.createIntent({
        environmentId,
        providerId: provider.id,
        profileId: "development",
        profileSnapshot: intent.profileSnapshot,
        provisionOperationId: "image-spare-operation",
        preparation: { purpose: "reserve", key, demandAtMs: 1_000, expiresAtMs: 10_000 },
      });
      await store.transition({ environmentId, from: "requested", to: "provisioning" });
      await store.transition({
        environmentId,
        from: "provisioning",
        to: "ready",
        patch: {
          ...support.readyPatch(environmentId, receipt),
          leaseId: "image-lease",
          nodeDeviceId: "image-node",
          sharedHost: false,
        },
      });
    }
    const { root, baseCommit } = await repository("accepted-source", { disableSigning: true });
    const manifest = await captureWorkspaceManifest({ root, baseCommit });
    await fs.writeFile(path.join(root, "session.txt"), "accepted image claim change\n");
    const checkpoint = await captureWorkspaceManifest({ root, baseCommit });
    const repositoryStore = getSessionRepositoryWorkspaceStore();
    const created = await repositoryStore.create({
      agentId: REQUEST.agentId,
      sessionKey: REQUEST.sessionKey,
      url: "https://github.com/example/image-claim.git",
      runSetupScript: false,
      assertCurrent() {},
    });
    const pinned = await repositoryStore.bindBase({
      workspaceId: created.workspaceId,
      expectedRevision: created.revision,
      baseCommit,
      baseManifestHash: manifest.manifestRef,
      assertCurrent() {},
    });
    const staged = await stageSessionRepositoryCheckpoint({
      workspaceId: pinned.workspaceId,
      expectedRevision: pinned.revision,
      stagingRoot: root,
      baseManifestRaw: serializeWorkerWorkspaceManifest(manifest.manifest),
      currentManifestRaw: serializeWorkerWorkspaceManifest(checkpoint.manifest),
      baseManifestRef: manifest.manifestRef,
      currentManifestRef: checkpoint.manifestRef,
      assertCurrent() {},
    });
    try {
      await staged.publish();
    } finally {
      await staged.discard();
    }
    const accepted = (await repositoryStore.get(created.workspaceId))!;
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const harness = await createHarness(support.testState.stateDb, placements, {
      environmentService: service,
      resolveWorkspace: async () => ({ kind: "repository", repository: accepted }),
      isCurrentNodePlacement: () => true,
    });
    bindDeviceWorkerAvailability(harness.environments, async () => ({
      available: true,
      node: createNodeWorkerBundleTestNode({
        nodeId: "image-node",
        workerHost: {
          enabled: true,
          environmentSession: 1,
          capturedExecPolicy: true,
          promptContext: 1,
          capacity: { total: 1, available: 1 },
        },
      }),
    }));
    const sync = vi.fn(
      async (input: Parameters<ReturnType<typeof harness.tunnelHandle>["syncWorkspace"]>[0]) => {
        input.authorize?.();
        expect(input.source).toMatchObject({
          kind: "repository",
          url: accepted.url,
          baseCommit,
          runSetupScript: false,
        });
        expect(input.source).not.toHaveProperty("prepared");
        if (input.source.kind !== "repository" || !input.source.checkpoint) {
          throw new Error("Repository checkpoint missing");
        }
        expect(
          await fs.readFile(path.join(input.source.checkpoint.stagingRoot, "session.txt"), "utf8"),
        ).toBe("accepted image claim change\n");
        return {
          mode: "repository" as const,
          remoteWorkspaceDir: "/worker/repository",
          baseCommit,
          baseManifestRef: manifest.manifestRef,
          manifestRef: checkpoint.manifestRef,
        };
      },
    );
    vi.spyOn(harness.environments, "startTunnel").mockImplementation(async ({ ownerEpoch }) => ({
      ...harness.tunnelHandle(ownerEpoch),
      environmentId,
      syncWorkspace: sync,
    }));
    const create = vi.spyOn(harness.environments, "createWithRequest");
    const prepare = vi.spyOn(harness.environments, "prepareProjectIntent");
    const bind = vi.spyOn(harness.environments, "bindPreparedWorkspace");
    const source = vi.spyOn(repositoryAdmission, "prepareRepositoryWorkerProjectSource");
    return {
      harness,
      placements,
      store,
      environmentId,
      provider,
      prepare,
      create,
      bind,
      source,
      sync,
      prepareNodeArtifacts,
    };
  }

  it.each(["live", "cold", "revoked-at-source", "missing-reader"] as const)(
    "claims runtime capacity and uses the current request for repository startup (%s)",
    async (phase) => {
      const f = await fixture(phase !== "cold");
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("Repository claim request revoked");
        }
      };
      const reader = Object.assign(
        vi.fn(async () => {
          // Native identity resolution must occur only after this request claims the image.
          expect(f.store.get(f.environmentId)?.attachedSessionIds).toEqual([REQUEST.sessionId]);
          if (phase === "revoked-at-source") {
            current = false;
          }
          return undefined;
        }),
        { assertCurrent },
      );
      const dispatch = f.harness.service.dispatch(
        {
          ...REQUEST,
          idempotencyKey: "image-dispatch",
          devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
          ...(phase === "missing-reader" ? {} : { readNativeCredential: reader }),
        },
        undefined,
        assertCurrent,
      );
      if (phase === "live" || phase === "cold") {
        await expect(dispatch).resolves.toMatchObject({
          state: "active",
          environmentId: f.environmentId,
          remoteWorkspaceDir: "/worker/repository",
        });
        expect(f.sync).toHaveBeenCalledOnce();
        expect(reader).toHaveBeenCalled();
        expect(f.store.get(f.environmentId)?.profileSnapshot.runtimePreparation).toMatchObject({
          source: "image",
        });
        if (phase === "live") {
          expect(f.store.get(f.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
        }
      } else {
        await expect(dispatch).rejects.toThrow(
          phase === "missing-reader"
            ? "current GitHub dispatch admission"
            : "Repository claim request revoked",
        );
        expect(f.sync).not.toHaveBeenCalled();
        if (phase === "missing-reader") {
          expect(f.store.get(f.environmentId)?.preparation?.consumedAtMs).toBeNull();
          expect(f.prepare).not.toHaveBeenCalled();
          expect(reader).not.toHaveBeenCalled();
        }
      }
      expect(f.source).not.toHaveBeenCalled();
      expect(f.bind).not.toHaveBeenCalled();
      expect(f.create).toHaveBeenCalledTimes(phase === "cold" ? 1 : 0);
      expect(f.provider.provision).toHaveBeenCalledTimes(phase === "cold" ? 1 : 0);
      if (phase !== "missing-reader") {
        const options = f.prepare.mock.calls[0]![1]!;
        expect(options.imageReserve).toBe(true);
        for (const field of [
          "repository",
          "projectPath",
          "readNativeCredential",
          "runSetupScript",
          "setupAuthorized",
        ]) {
          expect(options).not.toHaveProperty(field);
        }
      }
    },
  );
});
