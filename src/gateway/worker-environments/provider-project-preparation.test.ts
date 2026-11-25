import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import { ManagedWorktreeService } from "../../agents/worktrees/service.js";
import type {
  WorkerProvider,
  WorkerNodeRuntimePreparation,
  WorkerNodeEnrollment,
} from "../../plugins/types.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { completeWorkerNodeSetupForTest } from "./node-enrollment.test-support.js";
import { readWorkerProjectPreparation } from "./preparation-identity.schema.js";
import {
  beforeSettlement,
  create as createProject,
  nodeArtifacts,
  pendingNodeEnrollment,
  providerService,
  repository,
} from "./provider-lifecycle.test-support.js";
import * as support from "./service.test-support.js";
import * as workspaceGitBase from "./workspace-git-base.js";

type ProjectPreparation = NonNullable<
  NonNullable<Parameters<WorkerProvider["provision"]>[2]>["project"]
>;

function createService(
  provision: WorkerProvider["provision"],
  options: Parameters<typeof support.createService>[1] = {},
  provider: Partial<WorkerProvider> = {},
) {
  let credentialIndex = 0;
  return providerService(
    { supportsProjectPreparation: () => true, provision, ...provider },
    {
      projectNamespace: "gateway",
      generateWorkerCredential: () => `${support.CREDENTIAL}-${++credentialIndex}`,
      ...options,
    },
  );
}

const nodeProvider = {
  requiresNodeEnrollment: true,
  provisionBeforeInstallation: true,
  supportedExecutionModes: ["worker-turn"],
} satisfies Partial<WorkerProvider>;

describe("worker provider project preparation ownership", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each([
    [true, true],
    [true, false],
    [false, false],
  ])(
    "rejects unmapped repository secrets before provisioning (supported=%s, target=%s)",
    async (supported, hasTarget) => {
      const git = await repository("unmapped-secrets");
      await fs.writeFile(
        path.join(git.root, ".devcontainer.json"),
        JSON.stringify({
          secrets: { PACKAGE_TOKEN: {}, OTHER_TOKEN: {} },
          onCreateCommand: "must-never-run",
        }),
      );
      await requireGit(git.root, ["add", ".devcontainer.json"]);
      await requireGit(git.root, ["commit", "--quiet", "-m", "declare secrets"]);
      const provision = vi.fn<WorkerProvider["provision"]>();
      const service = createService(
        provision,
        {},
        {
          supportsProjectPreparation: () => supported,
          runSetupCommand: async () => undefined,
          resolvePreparationTarget: () =>
            hasTarget ? { machineClass: "small", platform: "linux" } : undefined,
        },
      );
      await expect(
        createProject(service, "unmapped-secrets", { projectPath: git.root }),
      ).rejects.toThrow("unmapped setup secrets: OTHER_TOKEN, PACKAGE_TOKEN");
      expect(provision).not.toHaveBeenCalled();
    },
  );

  it("keeps separate empty session workspaces on the same project-free allocation profile", async () => {
    const worktrees = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: support.testState.root },
      getConfig: () => ({ worktreeAcceleration: false }),
    });
    const provision = vi.fn<WorkerProvider["provision"]>(async (_profile, operationId) => ({
      leaseId: `lease-${operationId}`,
      ssh: support.SSH_ENDPOINT,
    }));
    const service = createService(provision);
    const environments = [];
    const roots = [];
    for (const name of ["first", "second"]) {
      const workspace = await worktrees.createEmpty({
        name,
        ownerKind: "session",
        ownerId: `agent:main:${name}`,
      });
      roots.push(workspace.repoRoot);
      environments.push(await createProject(service, name, { projectPath: workspace.path }));
    }
    expect(roots[0]).not.toBe(roots[1]);
    expect(provision).toHaveBeenCalledTimes(2);
    for (const call of provision.mock.calls) {
      expect(call[2]?.project).toBeUndefined();
    }
    expect(environments[0]?.profileSnapshot.project).toBeUndefined();
    expect(environments[1]?.profileSnapshot).toEqual(environments[0]?.profileSnapshot);
  });

  it.each(
    ([false, true, undefined] as const).flatMap((sharedHost) =>
      [false, true].map((emptyWorkspace) => ({ sharedHost, emptyWorkspace })),
    ),
  )(
    "requires explicit dedicated classification after prepared node provisioning (sharedHost=$sharedHost, empty workspace=$emptyWorkspace)",
    async ({ sharedHost, emptyWorkspace }) => {
      const git = await repository("prepared-host-classification", { empty: emptyWorkspace });
      const deviceId = "prepared-node";
      const registerPreparedWorkspace = vi.fn<
        NonNullable<support.WorkerEnvironmentServiceOptions["registerPreparedWorkspace"]>
      >(async ({ assertCurrent }) => assertCurrent());
      const provider = support.createProvider({
        ...nodeProvider,
        supportsProjectPreparation: () => true,
        resolvePreparationTarget: () => ({ machineClass: "small", platform: "linux" }),
        provision: async (_profile, _operationId, options) => {
          if (emptyWorkspace) {
            expect(options?.project).toBeUndefined();
          } else {
            const project = expectDefined(options?.project, "project preparation");
            const preparation = expectDefined(project.preparation, "prepared identity");
            const directory = `/worker/.openclaw-worker/prepared/gateway/${preparation.cacheKey}`;
            await project.prepare({
              runScript: async () => JSON.stringify({ ready: true, retainedWorkspace: null }),
              upload: async () => {
                throw new Error("cached seed must not upload");
              },
              runScriptWithBudget: async () =>
                JSON.stringify({
                  workspaceDir: `${directory}/workspace`,
                  homeDir: `${directory}/home`,
                  sourceManifestRef: `sha256:${"a".repeat(64)}`,
                  preparedManifestRef: `sha256:${"b".repeat(64)}`,
                  recipePreparation: { source: "none", phaseDurationsMs: {} },
                }),
            });
          }
          const enrollment = await options!.beginNodeEnrollment!();
          if (enrollment.mode !== "connect") {
            throw new Error("Fresh worker must use its pending enrollment");
          }
          await completeWorkerNodeSetupForTest({
            baseDir: support.testState.root,
            store: support.testState.store,
            setupId: enrollment.setupId,
            deviceId,
            completedAtMs: support.testState.nowMs,
          });
          return {
            leaseId: "lease-prepared-host",
            node: { deviceId: await enrollment.waitForDeviceId() },
            ...(sharedHost === undefined ? {} : { sharedHost }),
          };
        },
      });
      const service = support.createService(provider, {
        projectNamespace: "gateway",
        prepareNodeArtifacts: async () => nodeArtifacts(),
        prepareNodeEnrollment: (record) => pendingNodeEnrollment(record, async () => deviceId),
        ensureNodeWorkerBundle: async () => structuredClone(support.BOOTSTRAP_RECEIPT),
        registerPreparedWorkspace,
      });
      const creation = createProject(service, "prepared-host", {
        projectPath: git.root,
        executionMode: "worker-turn",
      });
      if (sharedHost !== false) {
        await expect(creation).rejects.toThrow("Prepared worker requires a dedicated environment");
        expect(registerPreparedWorkspace).not.toHaveBeenCalled();
        return;
      }
      const environment = await creation;
      expect(environment).toMatchObject({
        state: "ready",
        sharedHost: false,
        nodeDeviceId: deviceId,
      });
      if (emptyWorkspace) {
        expect(environment.profileSnapshot.project).toBeUndefined();
        expect(environment.profileSnapshot.runtimePreparation).toMatchObject({ source: "empty" });
        expect(registerPreparedWorkspace).not.toHaveBeenCalled();
        return;
      }
      const preparation = expectDefined(
        readWorkerProjectPreparation(environment.profileSnapshot.project),
        "prepared profile",
      );
      expect(registerPreparedWorkspace).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          record: expect.objectContaining({ environmentId: environment.environmentId }),
          deviceId,
          workspace: expect.objectContaining({
            preparationKey: preparation.key,
            cacheKey: preparation.cacheKey,
            sourceManifestRef: `sha256:${"a".repeat(64)}`,
            preparedManifestRef: `sha256:${"b".repeat(64)}`,
          }),
        }),
      );
    },
  );

  it.each(["runtime-bootstrap", "runtime-worker", "enrollment-bootstrap"] as const)(
    "closes changed %s grants without publishing a different prepared runtime identity",
    async (change) => {
      const isEnrollment = change === "enrollment-bootstrap";
      const git = await repository(`runtime-${change}`);
      const changedBootstrap = { ...support.NODE_BOOTSTRAP, sha256: "c".repeat(64) };
      const runtime: WorkerNodeRuntimePreparation = {
        nodeBootstrap: change === "runtime-bootstrap" ? changedBootstrap : support.NODE_BOOTSTRAP,
        workerBundle: {
          ...support.NODE_BOOTSTRAP,
          sha256:
            change === "runtime-worker" ? "d".repeat(64) : support.BUNDLE_ARTIFACT.tarballSha256,
          packageRelativePath: `worker-artifacts/${support.BUNDLE_ARTIFACT.tarballSha256}.tgz`,
        },
      };
      const enrollment: WorkerNodeEnrollment = {
        mode: "resume",
        deviceId: "runtime-node",
        displayName: "Runtime node",
        openclawVersion: support.NODE_BOOTSTRAP.openclawVersion,
        nodeBootstrap: changedBootstrap,
        waitForDeviceId: async () => "runtime-node",
      };
      const closeNodeRuntime = vi.fn();
      const closeNodeEnrollment = vi.fn();
      const service = createService(
        async (_profile, _operationId, options) => {
          expect(options?.nodeRuntimeIdentity).toEqual({
            nodeBootstrapSha256: support.NODE_BOOTSTRAP.sha256,
            executionMode: "worker-turn",
            workerBundleSha256: support.BUNDLE_ARTIFACT.tarballSha256,
          });
          await (isEnrollment ? options!.beginNodeEnrollment!() : options!.prepareNodeRuntime!());
          throw new Error("changed runtime must not reach provider installation");
        },
        {
          prepareNodeRuntime: async () => runtime,
          prepareNodeEnrollment: async () => enrollment,
          closeNodeRuntime,
          closeNodeEnrollment,
        },
        nodeProvider,
      );
      await expect(
        createProject(service, change, { projectPath: git.root, executionMode: "worker-turn" }),
      ).rejects.toThrow("runtime changed after provisioning preparation");
      expect(support.testState.store.list()[0]).toMatchObject({
        state: "provisioning",
        nodeDeviceId: null,
      });
      expect(isEnrollment ? closeNodeEnrollment : closeNodeRuntime).toHaveBeenCalledExactlyOnceWith(
        isEnrollment ? enrollment : runtime,
      );
      expect(isEnrollment ? closeNodeRuntime : closeNodeEnrollment).not.toHaveBeenCalled();
    },
  );

  it("cancels project snapshot preparation before creating an allocation intent", async () => {
    const git = await repository("cancelled-project-snapshot");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const controller = new AbortController();
    const original = workspaceGitBase.prepareWorkerProjectSnapshot;
    let snapshotSignal: AbortSignal | undefined;
    const snapshot = vi
      .spyOn(workspaceGitBase, "prepareWorkerProjectSnapshot")
      .mockImplementationOnce(async (params) => {
        snapshotSignal = params.signal;
        entered.resolve();
        await release.promise;
        return await original(params);
      });
    const provision = vi.fn<WorkerProvider["provision"]>();
    const service = createService(provision);
    const creation = createProject(service, "cancelled-project-snapshot", {
      projectPath: git.root,
      signal: controller.signal,
    }).catch((error: unknown) => error);
    try {
      await entered.promise;
      controller.abort(new DOMException("Stop project preparation", "AbortError"));
      await setImmediate();
      expect(snapshotSignal?.aborted).toBe(true);
    } finally {
      release.resolve();
      await creation;
      snapshot.mockRestore();
    }
    expect(await creation).toMatchObject({ name: "AbortError" });
    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()).toEqual([]);
  });

  it("interrupts an active project transfer but retains its provider until the transport settles", async () => {
    const git = await repository("cancelled-project-transfer");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const controller = new AbortController();
    const stopRecorded = createDeferredCore();
    const unsubscribe = sessionChanges.subscribe((change) => {
      if (
        "all" in change &&
        change.scope === "worker-environments" &&
        typeof support.testState.store.list()[0]?.destroyRequestedAtMs === "number"
      ) {
        stopRecorded.resolve();
      }
    });
    let transportSignal: AbortSignal | undefined;
    let settled = false;
    const events: string[] = [];
    const service = createService(async (_profile, _operationId, options) => {
      const project = expectDefined(options?.project, "provider project preparation");
      await project.prepare({
        runScript: async (_script, signal) => {
          transportSignal = signal;
          entered.resolve();
          await release.promise;
          events.push("transport settled");
          signal.throwIfAborted();
          return '{"ready":true}';
        },
        upload: async () => {
          throw new Error("No upload should follow canceled inspection");
        },
      });
      return { leaseId: "unexpected-transfer-lease", ssh: support.SSH_ENDPOINT };
    });
    const creation = createProject(service, "cancelled-project-transfer", {
      projectPath: git.root,
      signal: controller.signal,
    })
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await entered.promise;
      controller.abort(new DOMException("Stop project transfer", "AbortError"));
      await stopRecorded.promise;
      expect(transportSignal?.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(events).toEqual([]);
      expect(support.testState.store.list()[0]).toMatchObject({
        state: "provisioning",
        destroyRequestedAtMs: support.testState.nowMs,
      });
    } finally {
      unsubscribe();
      release.resolve();
      await creation;
    }
    expect(await creation).toMatchObject({ name: "AbortError" });
    expect(events).toEqual(["transport settled"]);
    expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
  });

  it("persists and replays project identity with a legacy provider hook", async () => {
    const git = await repository("project");
    await requireGit(git.root, ["remote", "add", "origin", "git@example.invalid:Team/Project.git"]);
    const projects: ProjectPreparation[] = [];
    const operationIds: string[] = [];
    const identity = {
      root: git.root,
      baseCommit: git.baseCommit,
      label: "example.invalid/team/project",
    };
    const provision: WorkerProvider["provision"] = async (_profile, operationId, options) => {
      const project = expectDefined(options?.project, "provider project preparation");
      projects.push(project);
      operationIds.push(operationId);
      const record = support.testState.store
        .list()
        .find((entry) => entry.provisionOperationId === operationId);
      expect(record).toMatchObject({
        state: "provisioning",
        leaseId: null,
        profileSnapshot: { project: { key: project.key, ...identity } },
      });
      expect(project.key).toMatch(/^[a-f0-9]{64}$/u);
      expect(project).toMatchObject(identity);
      expect(() => project.assertCurrent()).not.toThrow();
      if (projects.length === 1) {
        throw new Error("provider response was lost after allocation");
      }
      return { leaseId: "lease-project", ssh: support.SSH_ENDPOINT };
    };
    const supportsProjectPreparation = (_profile: unknown, selectedClass?: string) =>
      selectedClass === undefined;
    const first = createService(provision, {}, { supportsProjectPreparation });
    await expect(
      createProject(first, "project-replay", { projectPath: git.root }),
    ).rejects.toMatchObject({ code: "provider_failure" });
    expect(projects[0]?.signal.aborted).toBe(true);
    await fs.writeFile(path.join(git.root, "input.txt"), "newer project HEAD\n");
    await requireGit(git.root, ["commit", "--quiet", "-am", "advance"]);
    await requireGit(git.root, [
      "remote",
      "set-url",
      "origin",
      "git@example.invalid:Other/Project.git",
    ]);
    expect(await requireGit(git.root, ["rev-parse", "HEAD"])).not.toBe(git.baseCommit);
    await support.reopenWorkerEnvironmentStore();

    const restarted = createService(provision, {}, { supportsProjectPreparation });
    await expect(
      createProject(restarted, "project-replay", { projectPath: git.root }),
    ).resolves.toMatchObject({ state: "ready", leaseId: "lease-project" });
    expect(operationIds).toHaveLength(2);
    expect(operationIds[1]).toBe(operationIds[0]);
    expect(projects[1]).toMatchObject({ ...identity, key: projects[0]?.key });
    expect(projects[1]).not.toBe(projects[0]);
    expect(projects[1]?.signal.aborted).toBe(true);
  });

  it("a fresh inherited allocation uses only its current project", async () => {
    const first = await repository("inherited-project");
    const second = await repository("current-project");
    const projects: Array<ProjectPreparation | undefined> = [];
    const service = createService(async (_profile, operationId, options) => {
      projects.push(options?.project);
      return { leaseId: `lease-${operationId}`, ssh: support.SSH_ENDPOINT };
    });
    const original = await createProject(service, "original", { projectPath: first.root });
    const originalRecord = expectDefined(
      support.testState.store.get(original.environmentId),
      "original allocation",
    );
    const { providerId, profileSnapshot } = originalRecord;
    const request = {
      inheritedProfile: { providerId, profileSnapshot },
      projectPath: second.root,
    };
    const next = await createProject(service, "fresh", request);
    const nextRecord = expectDefined(
      support.testState.store.get(next.environmentId),
      "fresh allocation",
    );
    expect(nextRecord.profileSnapshot.project).toMatchObject({
      root: second.root,
      baseCommit: second.baseCommit,
    });
    expect(projects[1]?.key).not.toBe(projects[0]?.key);
    expect(projects[1]?.baseCommit).toBe(second.baseCommit);
    await expect(createProject(service, "fresh", request)).resolves.toMatchObject({
      environmentId: next.environmentId,
      state: "ready",
    });
    expect(projects).toHaveLength(2);
    expect(
      support.testState.store.get(original.environmentId)?.profileSnapshot.project,
    ).toMatchObject({ root: first.root, baseCommit: first.baseCommit });
  });

  it.each(["return", "timeout"])(
    "revokes retained project callbacks after provider %s",
    async (outcome) => {
      const git = await repository("closure-project");
      if (outcome === "timeout") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let retained: ProjectPreparation | undefined;
      const service = createService(
        async (_profile, _operationId, options) => {
          retained = options?.project;
          entered.resolve();
          if (outcome === "timeout") {
            await release.promise;
          }
          return { leaseId: "lease-closed-project", ssh: support.SSH_ENDPOINT };
        },
        { providerCallTimeoutMs: outcome === "timeout" ? 20 : undefined },
      );
      try {
        const creation = createProject(service, "closure", { projectPath: git.root }).catch(
          (error: unknown) => error,
        );
        await beforeSettlement(entered.promise, creation, "provider invocation");
        if (outcome === "timeout") {
          await vi.advanceTimersByTimeAsync(20);
        }
        expect(await creation).toMatchObject(
          outcome === "timeout" ? { code: "provider_failure" } : { state: "ready" },
        );
        const project = expectDefined(retained, "retained project callback");
        expect(project.signal.aborted).toBe(true);
        const transport = {
          runScript: vi.fn(async () => '{"ready":true}'),
          upload: vi.fn(async () => {}),
        };
        expect(() => project.assertCurrent()).toThrow();
        expect(() => project.prepare(transport)).toThrow();
        expect(transport.runScript).not.toHaveBeenCalled();
        expect(transport.upload).not.toHaveBeenCalled();
      } finally {
        release.resolve();
      }
    },
  );
});
