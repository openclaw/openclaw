import { describe, expect, it, vi } from "vitest";
import type { WorkerInstallationArtifact } from "./bundle.js";
import { createWorkerCredentialBroker } from "./credential-broker.js";
import { completeWorkerNodeSetupForTest } from "./node-enrollment.test-support.js";
import { createNodeWorkerBundleTestNode } from "./node-worker-bundle.test-support.js";
import { createWorkerPreparationIdentity } from "./preparation-identity.js";
import { readWorkerPreparation } from "./preparation-identity.schema.js";
import { PRESENCE_REPOSITORY, usePreparedPoolFixture } from "./prepared-pool.test-support.js";
import { createWorkerProviderIntent } from "./provider-intent.js";
import { createWorkerNodeProvisioning } from "./provider-node-provisioning.js";
import { prepareWorkerProviderProject } from "./provider-project-preparation.js";
import { workerProjectSeedKey } from "./workspace-git-base.js";

const sourceAdmission = vi.hoisted(() =>
  vi.fn<typeof import("./repository-project-admission.js").prepareRepositoryWorkerProjectSource>(),
);
vi.mock("./repository-project-admission.js", () => ({
  prepareRepositoryWorkerProjectSource: sourceAdmission,
}));

describe("prepared project retention compatibility", () => {
  const fixture = usePreparedPoolFixture();

  async function setup() {
    sourceAdmission
      .mockReset()
      .mockRejectedValue(new Error("Retention must not access the repository"));
    fixture.config.agents = { entries: { main: {} } };
    const options = fixture.intentOwnerOptions("gateway");
    const { target, artifacts } = readWorkerPreparation(fixture.profile())!;
    fixture.provider.resolvePreparationTarget = () => target;
    const project = structuredClone(PRESENCE_REPOSITORY);
    const profileSnapshot = { settings: {}, install: "bundle", executionMode: "worker-turn" };
    const preparation = createWorkerPreparationIdentity({
      namespace: "gateway",
      providerId: fixture.provider.id,
      profileId: "development",
      profileSnapshot,
      project,
      target,
      artifacts,
      setupRecipe: "e".repeat(40),
      runSetupScript: false,
    });
    const preparedProfile = { ...profileSnapshot, project: { ...project, preparation } };
    const record = await fixture.store.createIntent({
      environmentId: "retained",
      providerId: fixture.provider.id,
      profileId: "development",
      provisionOperationId: "provision:retained",
      profileSnapshot: preparedProfile,
    });
    const prepareNodeArtifacts = vi.fn(async () => ({ artifacts, assertCurrent() {} }));
    const providerFor = vi.fn(() => fixture.provider);
    const owner = createWorkerProviderIntent({
      ...options,
      providerFor,
      prepareNodeArtifacts,
      resumeProvision: async (environment) => environment,
    });
    return {
      record,
      preparation: readWorkerPreparation(record.profileSnapshot)!,
      preparedProfile,
      owner,
      project,
      artifacts,
      prepareNodeArtifacts,
      providerFor,
    };
  }

  it("uses repository admission and fences a changed source owner before allocation", async () => {
    const { owner, project } = await setup();
    let current = true;
    sourceAdmission.mockResolvedValue({
      project,
      setupRecipe: "e".repeat(40),
      recipe: {
        source: "script",
        identity: "e".repeat(40),
        inputs: { ".openclaw/worktree-setup.sh": "e".repeat(40) },
        env: {},
        onCreate: ["./.openclaw/worktree-setup.sh"],
      },
      assertCurrent: () => {
        if (!current) {
          throw new Error("Repository owner changed");
        }
      },
      revalidate: async () => {},
    });
    const intent = await owner.prepareIntent("development", {
      executionMode: "worker-turn",
      projectRepository: project,
      runSetupScript: false,
    });
    expect(sourceAdmission).toHaveBeenCalledOnce();
    expect(sourceAdmission.mock.calls[0]?.[0].expected).toEqual(project);
    expect(intent.profileSnapshot.project).toMatchObject({
      ...project,
      preparation: { setupRecipe: "e".repeat(40), runSetupScript: false },
    });
    expect(intent.profileSnapshot.project).not.toHaveProperty("root");
    current = false;
    const before = fixture.store.list();
    await expect(
      owner.createWithProfile(
        "development",
        "changed-repository",
        { executionMode: "worker-turn" },
        intent,
      ),
    ).rejects.toThrow("Repository owner changed");
    expect(fixture.store.list()).toEqual(before);
  });

  it("passes private pack production through the provisioning owner instead of worker fetch", async () => {
    const { project, record } = await setup();
    const stopped = new Error("Private pack producer stopped before transfer");
    const prepareGitPack = vi.fn(async () => {
      throw stopped;
    });
    const revalidate = vi.fn(async () => {});
    sourceAdmission.mockResolvedValue({
      project,
      setupRecipe: undefined,
      recipe: { source: "none", inputs: {}, env: {} },
      assertCurrent: () => {},
      revalidate,
      prepareGitPack,
    });
    const operation = await prepareWorkerProviderProject({
      project,
      preparation: undefined,
      record,
      namespace: "gateway",
      getConfig: () => fixture.config,
      requireCurrent: () => {},
      signal: fixture.abort.signal,
    });
    const runScript = vi.fn(async () =>
      JSON.stringify({
        ready: false,
        directory: `/node/.openclaw-worker/git-seeds/gateway/.tmp-${workerProjectSeedKey(project)}-fixture`,
      }),
    );
    const upload = vi.fn();
    try {
      await expect(operation.project.prepare({ runScript, upload })).rejects.toBe(stopped);
      expect(prepareGitPack).toHaveBeenCalledOnce();
      expect(revalidate).not.toHaveBeenCalled();
      expect(runScript).toHaveBeenCalledOnce();
      expect(upload).not.toHaveBeenCalled();
    } finally {
      operation.close();
    }
  });

  it.each([
    "fresh",
    "default mode/setup disabled",
    "profile settings disabled",
    "no snapshot",
    "shared host",
    "bootstrap drift",
    "bundle drift",
    "mode drift",
    "hooks enabled",
    "node drift",
    "registration without guard",
  ] as const)("keeps fresh-runtime reuse within provisioning ownership (%s)", async (scenario) => {
    const seed = fixture.profile();
    const artifacts = seed.project.preparation.artifacts;
    const settings: Record<string, boolean> = {};
    if (scenario === "profile settings disabled") {
      settings.runSetupScript = false;
    }
    const profileSnapshot = {
      settings,
      install: "bundle",
      ...(scenario === "default mode/setup disabled"
        ? {}
        : { executionMode: "worker-turn" as const }),
    };
    const project = structuredClone(PRESENCE_REPOSITORY);
    const hooks =
      scenario === "default mode/setup disabled" ||
      scenario === "profile settings disabled" ||
      scenario === "hooks enabled";
    const preparation = createWorkerPreparationIdentity({
      namespace: "gateway",
      providerId: fixture.provider.id,
      profileId: "development",
      profileSnapshot,
      project,
      target: seed.project.preparation.target,
      artifacts,
      runSetupScript: scenario === "hooks enabled" || scenario === "profile settings disabled",
      ...(hooks
        ? {
            setupRecipe: "e".repeat(40),
            recipe: {
              source: "script" as const,
              identity: "e".repeat(40),
              inputs: { ".openclaw/worktree-setup.sh": "e".repeat(40) },
              env: {},
              postCreate: ["echo create"],
              postStart: ["echo start"],
            },
          }
        : {}),
    });
    const intent = await fixture.store.createIntent({
      environmentId: "fresh-runtime",
      providerId: fixture.provider.id,
      profileId: "development",
      provisionOperationId: "provision:fresh-runtime",
      profileSnapshot: { ...profileSnapshot, project: { ...project, preparation } },
    });
    await fixture.store.transition({
      environmentId: intent.environmentId,
      from: "requested",
      to: "provisioning",
    });
    const enrollment = await fixture.store.ensureNodeEnrollment(intent.environmentId);
    if (!enrollment.nodeSetupId) {
      throw new Error("Expected a canonical node enrollment");
    }
    await completeWorkerNodeSetupForTest({
      baseDir: fixture.root,
      store: fixture.store,
      setupId: enrollment.nodeSetupId,
      deviceId: "node-fresh",
      completedAtMs: fixture.nowMs,
    });
    const record = fixture.store.get(intent.environmentId)!;
    expect(record).toMatchObject({
      state: "provisioning",
      nodeSetupId: enrollment.nodeSetupId,
      nodeDeviceId: "node-fresh",
    });
    const artifact: Extract<WorkerInstallationArtifact, { install: "bundle" }> = {
      install: "bundle",
      tarballSha256: artifacts.workerArchiveSha256,
      tarballBytes: 1,
      tarballPath: "/fixture/bundle.tgz",
      bundleHash: artifacts.workerBundleHash,
      openclawVersion: artifacts.openclawVersion,
      protocolFeatures: artifacts.protocolFeatures,
    };
    const move: Parameters<typeof createWorkerCredentialBroker>[0]["move"] = (
      current,
      to,
      patch,
      assertCurrent,
    ) =>
      fixture.store.transition({
        environmentId: current.environmentId,
        from: current.state,
        to,
        expectedOwnerEpoch: current.ownerEpoch,
        patch,
        assertCurrent,
      });
    const prepareInstallation = async () => artifact;
    const broker = createWorkerCredentialBroker({
      store: fixture.store,
      now: () => fixture.nowMs,
      isStopping: () => false,
      prepareInstallation,
      move,
      withLock: async (_id, run) => run(),
      cancelInferenceEnvironment: async () => {},
    });
    const ensureNodeWorkerBundle = vi.fn<
      NonNullable<Parameters<typeof createWorkerNodeProvisioning>[0]["ensureNodeWorkerBundle"]>
    >(async (input) => {
      input.assertCurrent?.();
      return {
        bundleHash: artifact.bundleHash,
        openclawVersion: artifact.openclawVersion,
        protocolFeatures: [...artifact.protocolFeatures],
      };
    });
    const nodeCurrent = () => true;
    const registerPreparedWorkspace = vi.fn<
      NonNullable<Parameters<typeof createWorkerNodeProvisioning>[0]["registerPreparedWorkspace"]>
    >(async (input) => {
      input.assertCurrent();
      return scenario === "registration without guard" ? undefined : nodeCurrent;
    });
    const owner = createWorkerNodeProvisioning({
      store: fixture.store,
      now: () => fixture.nowMs,
      isStopping: () => false,
      ownerSignal: fixture.abort.signal,
      prepareInstallation,
      ensureNodeWorkerBundle,
      registerPreparedWorkspace,
      move,
      commitReady: broker.commitReady,
      saveError: async (_record, error) => {
        throw error;
      },
      failBootstrap: async (_record, _lease, _provider, error) => {
        throw error;
      },
    });
    const workspace = {
      preparationKey: preparation.key,
      cacheKey: preparation.cacheKey,
      workspaceDir: "/worker/prepared/workspace",
      homeDir: "/worker/prepared/home",
      sourceManifestRef: `sha256:${"a".repeat(64)}`,
      preparedManifestRef: `sha256:${"b".repeat(64)}`,
    };
    const snapshot = {
      checkpointId: "checkpoint-fresh",
      baseCommit: project.baseCommit,
      sourceManifestRef: workspace.sourceManifestRef,
      preparedManifestRef: workspace.preparedManifestRef,
    };
    const registered = vi.fn();
    const initialNode = createNodeWorkerBundleTestNode({
      nodeId: "node-fresh",
      connId: "fixture-first",
    });
    const lease = {
      leaseId: "lease-fresh",
      sharedHost: scenario === "shared host",
      node: {
        deviceId: scenario === "node drift" ? "another-node" : "node-fresh",
        preparedRuntime: {
          nodeBootstrapSha256:
            scenario === "bootstrap drift" ? "1".repeat(64) : artifacts.nodeBootstrapSha256,
          workerBundleSha256: scenario === "bundle drift" ? "2".repeat(64) : artifact.tarballSha256,
          executionMode:
            scenario === "mode drift" ? ("remote-exec" as const) : ("worker-turn" as const),
        },
      },
    };
    const result = owner.finish(
      record,
      lease,
      fixture.provider,
      fixture.abort.signal,
      { leaseId: lease.leaseId, sharedHost: lease.sharedHost, desktop: null },
      artifact,
      undefined,
      workspace,
      undefined,
      scenario === "no snapshot" ? undefined : { snapshot, initialNode, registered },
    );
    if (scenario === "node drift" || scenario === "shared host") {
      await expect(result).rejects.toThrow(
        scenario === "node drift" ? "owner is no longer current" : "dedicated environment",
      );
      expect(fixture.store.get(record.environmentId)?.state).toBe("provisioning");
      expect(fixture.store.getCredential(record.environmentId)).toBeUndefined();
      expect(registerPreparedWorkspace).not.toHaveBeenCalled();
    } else {
      const ready = await result;
      expect(ready.state).toBe("ready");
      expect(fixture.store.get(record.environmentId)?.bootstrapReceipt?.bundleHash).toBe(
        artifact.bundleHash,
      );
      expect(fixture.store.getCredential(record.environmentId)?.ownerEpoch).toBe(ready.ownerEpoch);
      expect(registered).toHaveBeenCalledTimes(
        scenario === "no snapshot" || scenario === "registration without guard" ? 0 : 1,
      );
    }
    const installs = ensureNodeWorkerBundle.mock.calls.map(([input]) => {
      if (input.reason !== "provision") {
        throw new Error("Expected the provision installation owner");
      }
      return input;
    });
    if (scenario === "node drift") {
      expect(ensureNodeWorkerBundle).not.toHaveBeenCalled();
    } else if (scenario === "shared host") {
      expect(installs.every((input) => input.initialSnapshot === undefined)).toBe(true);
    } else {
      expect(ensureNodeWorkerBundle).toHaveBeenCalledOnce();
      const eligible =
        scenario === "fresh" ||
        scenario === "default mode/setup disabled" ||
        scenario === "profile settings disabled" ||
        scenario === "registration without guard";
      expect(installs[0]?.initialSnapshot).toBe(eligible ? snapshot.checkpointId : undefined);
    }
  });

  it("checks canonical retained contents without source admission or an allocation authority", async () => {
    const { record, preparation, preparedProfile, owner } = await setup();
    const retained = await owner.prepareRetention(record, preparation, fixture.abort.signal);
    expect(retained).toBeDefined();
    expect(retained!.isCurrent()).toBe(true);
    expect(sourceAdmission).not.toHaveBeenCalled();
    expect(fixture.store.get(record.environmentId)).toEqual(record);
    expect(() =>
      owner.assertPreparedIntentCurrent(record.profileId, {
        providerId: record.providerId,
        profileSnapshot: preparedProfile,
      }),
    ).toThrow("not owned by this lifecycle");
  });

  it.each(["provider", "target", "owner selection", "agent deletion"])(
    "rejects %s drift on the next retention pass without external source authority",
    async (mutation) => {
      const { record, preparation, owner, providerFor } = await setup();
      const retained = await owner.prepareRetention(record, preparation, fixture.abort.signal);
      expect(retained).toBeDefined();
      const unavailable = mutation === "owner selection" || mutation === "agent deletion";
      if (unavailable) {
        expect(retained?.isCurrent()).toBe(true);
        providerFor.mockClear().mockImplementation(() => {
          throw new Error("Worker provider registry temporarily unavailable");
        });
      }
      if (mutation === "provider") {
        fixture.developmentProfile.provider = "another-provider";
      } else if (mutation === "target") {
        fixture.provider.resolvePreparationTarget = () => ({
          machineClass: "large",
          platform: "linux",
          arch: "x64",
        });
      } else if (mutation === "owner selection") {
        fixture.config.tools = { github: { kind: "oauth", profileId: `ghp_${"a".repeat(32)}` } };
      } else {
        fixture.config.agents = { entries: { other: {} } };
      }
      if (unavailable) {
        expect(retained?.isCurrent()).toBe(false);
      }
      expect(
        await owner.prepareRetention(record, preparation, fixture.abort.signal),
      ).toBeUndefined();
      if (unavailable) {
        expect(providerFor).not.toHaveBeenCalled();
      }
      expect(sourceAdmission).not.toHaveBeenCalled();
    },
  );

  it("rejects agent removal during lifecycle preparation before preparing artifacts", async () => {
    const { record, preparation, owner, prepareNodeArtifacts } = await setup();
    const pending = owner.prepareRetention(record, preparation, fixture.abort.signal);
    fixture.config.agents = { entries: { other: {} } };

    await expect(pending).resolves.toBeUndefined();
    expect(prepareNodeArtifacts).not.toHaveBeenCalled();
    expect(sourceAdmission).not.toHaveBeenCalled();
  });

  it("rejects an old runtime fingerprint on the first retention pass after restart", async () => {
    const { record, preparation, owner, artifacts } = await setup();
    artifacts.workerArchiveSha256 = "1".repeat(64);
    expect(await owner.prepareRetention(record, preparation, fixture.abort.signal)).toBeUndefined();
    expect(sourceAdmission).not.toHaveBeenCalled();
  });

  it("reports why activation demand cannot refill after runtime artifacts change", async () => {
    const { record, owner, artifacts } = await setup();
    const activated = await fixture.attach(await fixture.ready(record));
    artifacts.workerArchiveSha256 = "1".repeat(64);
    const warn = vi.fn();
    const pool = fixture.pool({ prepareRetention: owner.prepareRetention, warn });
    await pool.maintain(activated.environmentId);
    expect(fixture.reserves()).toEqual([]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "Prepared worker refill skipped (development, retained): runtime artifacts or preparation identity changed",
    );
  });
});
