import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { clearGitHubCredentialVerificationCache } from "../../agents/github-oauth-client.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { prepareUserProfileCatalogForTest } from "../../test-utils/user-profile-catalog.js";
import {
  repositoryDispatchCredentialReader,
  withRepositoryChatDispatch,
} from "../repository-dispatch.js";
import type { GatewayClient } from "../server-methods/client-types.js";
import { bindDeviceWorkerAvailability } from "./device-provider.js";
import { imageReserveEffectsFixture } from "./image-reserve-effects.test-support.js";
import { completeWorkerNodeSetupForTest } from "./node-enrollment.test-support.js";
import { createNodeWorkerBundleTestNode } from "./node-worker-bundle.test-support.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { WORKER_PROTOCOL_FEATURES } from "./placement-lifecycle.test-support.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { nodeArtifacts, pendingNodeEnrollment } from "./provider-lifecycle.test-support.js";
import { assertNoCredentialFiles, TOKEN } from "./repository-git-pack.test-support.js";
import {
  createManagedRepositoryProfile,
  createRepositoryNodeFixture,
} from "./repository-policy-node.test-support.js";
import * as repositoryAdmission from "./repository-project-admission.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import * as support from "./service.test-support.js";
import { stageSessionRepositoryCheckpoint } from "./session-repository-checkpoints.js";
import { createWorkerPlacementRedispatch } from "./worker-placement-redispatch.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { requireWorkspaceResultGit } from "./workspace-result-git.js";

describe("runtime image reserve repository dispatch", () => {
  support.setupWorkerEnvironmentServiceSuite((config) => {
    config.gateway = { repositoryIntegration: "image-policy" };
  });
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    clearGitHubCredentialVerificationCache();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function fixture(
    reserve: boolean,
    kind: "app-installation" | "pat" | "oauth" = "app-installation",
  ) {
    vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
    const effects = await imageReserveEffectsFixture();
    if (kind !== "app-installation") {
      await createManagedRepositoryProfile({
        agentId: REQUEST.agentId,
        profileId: effects.selection.profileId,
        stateDir: support.testState.root,
        token: TOKEN,
      });
    }
    support.testState.config.tools = {
      github:
        kind === "app-installation"
          ? effects.selection
          : { profileId: effects.selection.profileId, ...(kind === "oauth" ? { kind } : {}) },
    };
    setRuntimeConfigSnapshot(support.testState.config);
    const owner = ensureProfileForEmail("image-owner@example.invalid");
    const other = ensureProfileForEmail("image-other@example.invalid");
    const profiles = await prepareUserProfileCatalogForTest();
    onTestFinished(profiles.release);
    const client: GatewayClient = {
      connId: "image-owner-connection",
      authenticatedUserProfile: {
        profileId: owner.id,
        displayName: null,
        hasAvatar: false,
        updatedAt: 1,
      },
      authenticatedGitHubAccountId: 42,
      internal: { authenticatedOperator: true },
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "cli", mode: "cli", platform: "test", version: "test" },
        role: "operator",
        scopes: ["operator.write"],
      },
    };
    let policyCurrent = true;
    const admissions: string[] = [];
    const hooks: { beforeCommand?: () => void } = {};
    const nativeRead = vi.fn();
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
      withIdentity: async (context, run) => {
        admissions.push(context.actor.profileId);
        const assertCurrent = () => {
          context.assertCurrent();
          if (
            !policyCurrent ||
            context.actor.profileId !== owner.id ||
            !context.readCurrentProfile().emails.includes("image-owner@example.invalid")
          ) {
            throw new Error("Image repository policy denied");
          }
        };
        assertCurrent();
        return await run({
          env: context.env,
          assertCurrent,
          readNativeCredential: async (_env, admission) => {
            nativeRead();
            if (kind !== "app-installation") {
              throw new Error("Managed bearer lookup must remain with the native profile owner");
            }
            assertCurrent();
            expect(admission?.selection.app).not.toHaveProperty("privateKey");
            expect(
              support.testState.store
                .list()
                .some(
                  (row) =>
                    row.state === "attached" && row.attachedSessionIds.includes(REQUEST.sessionId),
                ),
            ).toBe(true);
            return undefined;
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);
    const features = [...WORKER_PROTOCOL_FEATURES];
    const receipt = { ...support.BOOTSTRAP_RECEIPT, protocolFeatures: features };
    vi.mocked(support.testState.prepareInstallation).mockResolvedValue({
      ...support.BUNDLE_ARTIFACT,
      protocolFeatures: features,
    });
    const lostLeases = new Set<string>();
    const provider = support.createProvider({
      inspect: async ({ leaseId }) => ({
        status: lostLeases.has(leaseId) ? "destroyed" : "active",
      }),
      supportedExecutionModes: ["worker-turn"],
      requiresNodeEnrollment: true,
      supportsProjectPreparation: () => true,
      resolvePreparationTarget: () => ({ machineClass: "small", platform: "linux" }),
      provision: vi.fn(async (_profile, operationId, options) => {
        expect(options?.project).toBeUndefined();
        const enrollment = await options!.beginNodeEnrollment!();
        if (enrollment.mode !== "connect") {
          throw new Error("Expected image enrollment");
        }
        await completeWorkerNodeSetupForTest({
          baseDir: support.testState.root,
          store: support.testState.store,
          setupId: enrollment.setupId,
          deviceId: operationId,
          completedAtMs: support.testState.nowMs,
        });
        return {
          leaseId: "lease:" + operationId,
          node: { deviceId: operationId },
          sharedHost: false,
        };
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
        pendingNodeEnrollment(environment, async () => environment.provisionOperationId),
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
    const root = path.join(effects.git.root, "source");
    const baseCommit = effects.git.baseCommit;
    await requireWorkspaceResultGit(root, ["checkout", "--detach", baseCommit]);
    const manifest = await captureWorkspaceManifest({ root, baseCommit });
    await fs.writeFile(path.join(root, "session.txt"), "accepted image claim change\n");
    const checkpoint = await captureWorkspaceManifest({ root, baseCommit });
    const repositoryStore = getSessionRepositoryWorkspaceStore();
    const created = await repositoryStore.create({
      agentId: REQUEST.agentId,
      sessionKey: REQUEST.sessionKey,
      url: effects.url,
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
    bindDeviceWorkerAvailability(harness.environments, async (deviceId) => ({
      available: true,
      node: createNodeWorkerBundleTestNode({
        nodeId: deviceId,
        workerHost: {
          enabled: true,
          environmentSession: 1,
          capturedExecPolicy: true,
          promptContext: 1,
          capacity: { total: 1, available: 1 },
        },
      }),
    }));
    const nodeHomes: string[] = [];
    let commands = 0;
    vi.spyOn(harness.environments, "startTunnel").mockImplementation(async (binding) => {
      const nodeHome = path.join(support.testState.root, "effect-node-" + nodeHomes.length);
      nodeHomes.push(nodeHome);
      const node = await createRepositoryNodeFixture({ nodeHome, store });
      const actions = createNodeWorkerWorkspaceActions({
        environmentId: binding.environmentId,
        ownerEpoch: binding.ownerEpoch,
        sessionId: REQUEST.sessionId,
        ownerSignal: new AbortController().signal,
        isOwnerCurrent: () => store.get(binding.environmentId)?.ownerEpoch === binding.ownerEpoch,
        workspaceTransfer: node.workspaceTransfer,
        runWorkspaceCommand: async (command) => {
          await Promise.resolve();
          hooks.beforeCommand?.();
          command.assertCurrent?.();
          commands++;
          return await node.runtime.exec(
            {
              gatewayNamespace: "image-effect-proof",
              environmentId: binding.environmentId,
              sessionId: REQUEST.sessionId,
              sessionKey: command.sessionKey,
              generation: binding.ownerEpoch,
              argv: command.argv.map(effects.translate),
              input: command.input === undefined ? undefined : effects.translate(command.input),
              timeoutMs: command.timeoutMs,
              resetWorkspace: command.resetWorkspace,
              seed: command.seed,
              transfer: command.transfer,
            },
            undefined,
            { url: node.gatewayUrl },
          );
        },
      });
      return {
        ...harness.tunnelHandle(binding.ownerEpoch),
        ...actions,
        environmentId: binding.environmentId,
      };
    });
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
      effects,
      nativeRead,
      admissions,
      hooks,
      client,
      owner,
      other,
      nodeHomes,
      service,
      lostLeases,
      accepted,
      commands: () => commands,
      revoke: () => {
        policyCurrent = false;
      },
    };
  }

  const requirement = { requiredNodeCommands: [], consumesWorkerSlot: true };
  it.each([
    "claim",
    "cold",
    "unauthorized",
    "revoked-before-issue",
    "reassigned-before-issue",
    "revoked-before-checkout",
    "missing-reader",
  ] as const)("fences native credential issuance and real image checkout (%s)", async (phase) => {
    const f = await fixture(phase !== "cold");
    expect(f.effects.counts.issued).toBe(0);
    expect(f.effects.git.requests).toEqual([]);
    if (phase === "unauthorized") {
      f.client.authenticatedUserProfile!.profileId = f.other.id;
    }
    let reached = false;
    if (phase === "revoked-before-issue" || phase === "reassigned-before-issue") {
      f.effects.hooks.afterMetadata = () => {
        reached = true;
        if (phase === "revoked-before-issue") {
          f.revoke();
        } else {
          f.client.authenticatedUserProfile!.profileId = f.other.id;
        }
      };
    }
    if (phase === "revoked-before-checkout") {
      f.hooks.beforeCommand = () => {
        reached = true;
        f.revoke();
      };
    }
    const reader = repositoryDispatchCredentialReader({
      ...REQUEST,
      client: f.client,
      requestDigest: "image-initial",
      assertCurrent() {},
    });
    const dispatch = f.harness.service.dispatch({
      ...REQUEST,
      idempotencyKey: "image-dispatch",
      devicePlacement: requirement,
      ...(phase === "missing-reader" ? {} : { readNativeCredential: reader }),
    });
    if (phase === "claim" || phase === "cold") {
      const active = await dispatch;
      expect(active).toMatchObject({ state: "active", environmentId: f.environmentId });
      expect(await fs.readFile(path.join(active.remoteWorkspaceDir!, "input.txt"), "utf8")).toBe(
        "pinned private content\n",
      );
      expect(await fs.readFile(path.join(active.remoteWorkspaceDir!, "session.txt"), "utf8")).toBe(
        "accepted image claim change\n",
      );
      expect(
        await requireWorkspaceResultGit(active.remoteWorkspaceDir!, ["branch", "--show-current"]),
      ).toBe(f.accepted.branch);
      expect(f.effects.counts).toMatchObject({ issued: 1, revoked: 1 });
      expect(f.effects.git.requests.length).toBeGreaterThan(0);
      expect(f.commands()).toBeGreaterThan(0);
      for (const home of f.nodeHomes) {
        await assertNoCredentialFiles(home);
      }
    } else {
      await expect(dispatch).rejects.toThrow(
        /policy|authority|identity|current GitHub dispatch admission/i,
      );
      expect(f.effects.counts.issued).toBe(phase === "revoked-before-checkout" ? 1 : 0);
      expect(f.effects.git.requests).toEqual([]);
      expect(f.commands()).toBe(0);
      if (phase.startsWith("revoked") || phase.startsWith("reassigned")) {
        expect(reached).toBe(true);
      }
      if (phase === "unauthorized") {
        expect(f.admissions).toEqual([f.other.id]);
      }
      if (phase === "missing-reader") {
        expect(f.store.get(f.environmentId)?.preparation?.consumedAtMs).toBeNull();
        expect(f.prepare).not.toHaveBeenCalled();
      }
    }
    expect(f.source).not.toHaveBeenCalled();
    expect(f.bind).not.toHaveBeenCalled();
    expect(f.create).toHaveBeenCalledTimes(phase === "cold" ? 1 : 0);
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
  });

  it.each([
    ["pat", "claim"],
    ["oauth", "cold"],
    ["pat", "denied"],
    ["oauth", "denied"],
    ["pat", "retired"],
  ] as const)("preserves managed %s image admission through %s", async (kind, scenario) => {
    const f = await fixture(scenario !== "cold", kind);
    if (scenario === "denied") {
      f.revoke();
    }
    let retired = false;
    if (scenario === "retired") {
      f.hooks.beforeCommand = () => {
        retired = true;
        f.client.invalidated = true;
      };
    }
    const reader = repositoryDispatchCredentialReader({
      ...REQUEST,
      client: f.client,
      requestDigest: "managed-image",
      assertCurrent() {},
    });
    const dispatch = f.harness.service.dispatch({
      ...REQUEST,
      idempotencyKey: "image-dispatch",
      devicePlacement: requirement,
      readNativeCredential: reader,
    });
    if (scenario === "claim" || scenario === "cold") {
      const active = await dispatch;
      expect(await fs.readFile(path.join(active.remoteWorkspaceDir!, "input.txt"), "utf8")).toBe(
        "pinned private content\n",
      );
      expect(await fs.readFile(path.join(active.remoteWorkspaceDir!, "session.txt"), "utf8")).toBe(
        "accepted image claim change\n",
      );
      expect(f.effects.git.requests.length).toBeGreaterThan(0);
      expect(f.effects.counts.verified).toBe(1);
      for (const home of f.nodeHomes) {
        await assertNoCredentialFiles(home);
      }
    } else {
      await expect(dispatch).rejects.toThrow(/policy|authority|identity/i);
      expect(f.commands()).toBe(0);
      expect(f.effects.git.requests).toEqual([]);
      expect(f.effects.counts.verified).toBe(scenario === "retired" ? 1 : 0);
      expect(retired).toBe(scenario === "retired");
    }
    expect(f.admissions).toEqual([f.owner.id]);
    expect(f.nativeRead).not.toHaveBeenCalled();
    expect(f.effects.counts.issued).toBe(0);
    expect(f.source).not.toHaveBeenCalled();
  });

  it.each([
    ["app-installation", true],
    ["app-installation", false],
    ["oauth", true],
    ["oauth", false],
  ] as const)(
    "recovers image checkout with a fresh %s repository caller (allowed=%s)",
    async (kind, allowed) => {
      const f = await fixture(true, kind);
      const reader = repositoryDispatchCredentialReader({
        ...REQUEST,
        client: f.client,
        requestDigest: "initial",
        assertCurrent() {},
      });
      const initial = await f.harness.service.dispatch({
        ...REQUEST,
        devicePlacement: requirement,
        readNativeCredential: reader,
      });
      await fs.writeFile(
        path.join(initial.remoteWorkspaceDir!, "unaccepted.txt"),
        "not in the checkpoint",
      );
      f.lostLeases.add(f.store.get(initial.environmentId)!.leaseId!);
      await f.service.reconcileOnce();
      await f.harness.service.reconcile();
      const failed = (await f.placements.getAsync(REQUEST.sessionId))!;
      expect(failed.state).toBe("failed");
      const beforeRequests = f.effects.git.requests.length;
      const recoveredClient: GatewayClient = {
        ...f.client,
        connId: "fresh-recovery",
        authenticatedUserProfile: {
          ...f.client.authenticatedUserProfile!,
          profileId: allowed ? f.owner.id : f.other.id,
        },
      };
      const redispatch = createWorkerPlacementRedispatch({
        placements: f.placements,
        dispatch: f.harness.service.dispatch,
        resolveDevicePlacementRequirement: async () => requirement,
      });
      if (failed.state !== "failed") {
        throw new Error("Expected recoverable provider loss");
      }
      const recovery = withRepositoryChatDispatch(
        {
          client: recoveredClient,
          agentId: REQUEST.agentId,
          sessionKey: REQUEST.sessionKey,
          getSessionId: () => REQUEST.sessionId,
          runId: "recovered-turn",
          assertCurrent() {},
        },
        () => redispatch(failed, { assertCurrent() {} }),
      );
      if (allowed) {
        const active = await recovery;
        expect(active.environmentId).not.toBe(initial.environmentId);
        expect(
          await fs.readFile(path.join(active.remoteWorkspaceDir!, "session.txt"), "utf8"),
        ).toBe("accepted image claim change\n");
        await expect(
          fs.access(path.join(active.remoteWorkspaceDir!, "unaccepted.txt")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(f.effects.counts).toMatchObject(
          kind === "app-installation" ? { issued: 2, revoked: 2 } : { issued: 0, revoked: 0 },
        );
        expect(f.effects.git.requests.length).toBeGreaterThan(beforeRequests);
      } else {
        await expect(recovery).rejects.toThrow(/policy|identity/i);
        expect(f.effects.counts.issued).toBe(kind === "app-installation" ? 1 : 0);
        expect(f.effects.git.requests).toHaveLength(beforeRequests);
        expect(f.admissions.at(-1)).toBe(f.other.id);
      }
      if (kind === "oauth") {
        expect(f.nativeRead).not.toHaveBeenCalled();
        expect(f.admissions).toEqual([f.owner.id, allowed ? f.owner.id : f.other.id]);
      }
    },
  );
});
