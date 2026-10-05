import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { FEATURES, preparedHarness } from "./placement-dispatch-prepared.harness.js";
import { MANIFEST_REF, REQUEST } from "./placement-dispatch-test-fixtures.js";
import * as support from "./service.test-support.js";
import {
  readSessionRepositoryArtifacts,
  stageSessionRepositoryCheckpoint,
} from "./session-repository-checkpoints.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { requireWorkspaceResultGit } from "./workspace-result-git.js";

const diagnostics = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("../../logging/subsystem.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../logging/subsystem.js")>();
  return {
    ...original,
    createSubsystemLogger: (name: string) => {
      const logger = original.createSubsystemLogger(name);
      return name === "gateway/worker-placement" ? { ...logger, info: diagnostics.info } : logger;
    },
  };
});

vi.mock("./worker-github-binding.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./worker-github-binding.js")>()),
  prepareWorkerRepositoryGitHubIdentity: vi.fn(),
  prepareWorkerGitHubBindingGrant: vi.fn(),
}));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  getRuntimeConfig: () => ({
    gateway: { nodes: { commands: { allow: ["codex.exec-server.stdio.v1"] } } },
  }),
}));

describe("prepared worker dispatch", () => {
  support.setupWorkerEnvironmentServiceSuite();
  beforeEach(() => diagnostics.info.mockClear());

  it.each(["worker-turn", "remote-exec"] as const)(
    "consumes the existing environment and binds its workspace for %s",
    async (executionMode) => {
      const { harness, placements, store, ready, request } = await preparedHarness({
        executionMode,
      });
      vi.mocked(harness.environments.schedulePreparedRefill).mockImplementation(() => {
        expect(placements.get(request.sessionId)?.state).toBe("active");
        throw new Error("refill scheduling failed");
      });

      const active = await harness.service.dispatch(request);

      expect(active).toMatchObject({
        state: "active",
        environmentId: ready.environmentId,
        executionMode,
      });
      expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
      expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
      expect(store.getCredential(ready.environmentId)).toMatchObject({
        sessionId: request.sessionId,
        ownerEpoch: active.activeOwnerEpoch,
      });
      expect(harness.log.indexOf("workspace:bind-prepared")).toBeLessThan(
        harness.log.indexOf("sync"),
      );
      expect(harness.environments.schedulePreparedRefill).toHaveBeenCalledWith(ready.environmentId);
      const stages = diagnostics.info.mock.calls
        .filter(
          ([message, facts]) =>
            message === "worker placement stage" && facts.sessionId === request.sessionId,
        )
        .map(([, facts]) => facts.stage);
      expect(stages).toEqual([
        "local_barrier_started",
        "local_barrier_completed",
        "workspace_resolve_started",
        "workspace_resolve_completed",
        "intent_prepare_started",
        "intent_prepare_completed",
        "dispatch_prepared_repository_revalidation_started",
        "dispatch_prepared_repository_revalidation_completed",
        "prepared_selection_started",
        "prepared_claimed",
        "prepared_selection_completed",
        "environment_ready",
        "session_attach_started",
        "session_attached",
        "tunnel_started",
        "tunnel_ready",
        "workspace_sync_started",
        "dispatch_workspace_preparation_started",
        "dispatch_workspace_preparation_completed",
        "workspace_sync_completed",
        "dispatch_post_sync_repository_revalidation_started",
        "dispatch_post_sync_repository_revalidation_completed",
        "activation_started",
        "active",
        "activation_completed",
      ]);
      expect(diagnostics.info.mock.calls.every(([, facts]) => typeof facts.atMs === "number")).toBe(
        true,
      );
      const logged = JSON.stringify(diagnostics.info.mock.calls);
      expect(logged).not.toContain("/gateway/workspace");
      expect(logged).not.toContain("credentialHash");
      const spans = diagnostics.info.mock.calls.filter(
        ([, facts]) => facts.stage?.endsWith("_completed") && typeof facts.elapsedMs === "number",
      );
      expect(spans.length).toBeGreaterThanOrEqual(5);
      expect(spans.every(([, facts]) => facts.elapsedMs >= 0)).toBe(true);
      const tunnel = await vi.mocked(harness.environments.startTunnel).mock.results[0]?.value;
      expect(tunnel?.syncWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: request.sessionKey }),
      );
    },
  );

  it.each(["completed", "failed", "sink"] as const)(
    "observes the actual repository revalidation await with %s outcome",
    async (outcome) => {
      const { harness, placements, request } = await preparedHarness();
      let now = 100;
      const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
      const failure = new Error("synthetic private repository failure");
      vi.mocked(harness.environments.revalidatePreparedIntentRepository).mockImplementationOnce(
        async () => {
          await Promise.resolve();
          now = 117;
          if (outcome === "failed") {
            throw failure;
          }
        },
      );
      if (outcome === "sink") {
        diagnostics.info.mockImplementation(() => {
          throw new Error("synthetic diagnostic sink");
        });
      }
      try {
        if (outcome === "failed") {
          await expect(harness.service.dispatch(request)).rejects.toBe(failure);
          expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
          expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
        } else {
          await expect(harness.service.dispatch(request)).resolves.toMatchObject({
            state: "active",
          });
          expect(placements.get(request.sessionId)?.state).toBe("active");
        }
        const calls = diagnostics.info.mock.calls.filter(([, facts]) =>
          facts.stage?.startsWith("dispatch_prepared_repository_revalidation_"),
        );
        expect(calls.map(([, facts]) => facts.stage)).toEqual([
          "dispatch_prepared_repository_revalidation_started",
          `dispatch_prepared_repository_revalidation_${outcome === "failed" ? "failed" : "completed"}`,
        ]);
        expect(calls[1]?.[1]).toMatchObject({
          sessionId: request.sessionId,
          generation: expect.any(Number),
          elapsedMs: 17,
        });
        expect(JSON.stringify(diagnostics.info.mock.calls)).not.toContain(failure.message);
      } finally {
        clock.mockRestore();
        diagnostics.info.mockReset();
      }
    },
  );

  it("denies a prepared repository from another source before binding", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const repository = await getSessionRepositoryWorkspaceStore().create({
      agentId: REQUEST.agentId,
      sessionKey: REQUEST.sessionKey,
      url: "https://github.com/example/project.git",
      runSetupScript: false,
      assertCurrent: () => {},
    });
    const { harness, request } = await preparedHarness({
      repository,
      reserveSourceUrl: "https://github.com/example/other.git",
    });

    await expect(harness.service.dispatch(request)).rejects.toThrow(
      "Prepared repository does not match this session's source",
    );
    expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
  });

  it("binds a freshly prepared cold workspace without turning its ordinary row into a reserve", async () => {
    const { harness, store, ready, intent, request } = await preparedHarness({ reserve: false });

    const active = await harness.service.dispatch(request);

    expect(active.environmentId).toBe(ready.environmentId);
    expect(harness.environments.createWithRequest).toHaveBeenCalledWith({
      profileId: request.profileId,
      idempotencyKey: expect.any(String),
      executionMode: request.executionMode,
      projectPath: "/gateway/workspace",
      admittedIntent: intent,
    });
    expect(store.get(ready.environmentId)?.preparation).toBeNull();
    expect(harness.environments.bindPreparedWorkspace).toHaveBeenCalledOnce();
    expect(harness.log.indexOf("workspace:bind-prepared")).toBeLessThan(
      harness.log.indexOf("sync"),
    );
  });

  it.each(["build", "node", "exec-authority"] as const)(
    "uses the cold path when a candidate's %s proof is stale",
    async (stale) => {
      const { harness, store, ready, request, revokeNode } = await preparedHarness({
        protocolFeatures:
          stale === "exec-authority" ? [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE] : undefined,
      });
      if (stale === "build") {
        const environment = harness.environments.get(ready.environmentId)!;
        vi.mocked(harness.environments.getPreparedCandidates).mockReturnValue(
          Array.from({ length: 12 }, (_, index) => ({
            ...environment,
            environmentId: index === 0 ? ready.environmentId : `rejected-spare-${index}`,
            bootstrapReceipt: { ...ready.bootstrapReceipt!, bundleHash: "9".repeat(64) },
          })),
        );
      } else if (stale === "node") {
        revokeNode();
      }

      const active = await harness.service.dispatch(request);

      expect(active.environmentId).toBe(harness.ready.environmentId);
      expect(active.environmentId).not.toBe(ready.environmentId);
      expect(harness.environments.createWithRequest).toHaveBeenCalledOnce();
      expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
      expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
      expect(diagnostics.info).toHaveBeenCalledWith("worker prepared candidate rejected", {
        sessionId: request.sessionId,
        environmentId: ready.environmentId,
        code:
          stale === "build"
            ? "build_mismatch"
            : stale === "node"
              ? "node_authority_changed"
              : "launch_protocol_mismatch",
        atMs: expect.any(Number),
      });
      if (stale === "build") {
        expect(
          diagnostics.info.mock.calls.filter(
            ([message]) => message === "worker prepared candidate rejected",
          ),
        ).toHaveLength(8);
        expect(diagnostics.info).toHaveBeenCalledWith(
          "worker placement stage",
          expect.objectContaining({
            stage: "prepared_selection_completed",
            candidateCount: 12,
            rejectedCount: 12,
            prepared: false,
          }),
        );
      }
    },
  );

  it("keeps the prepared claim and activation when its diagnostic sink throws", async () => {
    const { harness, ready, request } = await preparedHarness();
    diagnostics.info.mockImplementation(() => {
      throw new Error("synthetic log sink failure");
    });
    try {
      expect(await harness.service.dispatch(request)).toMatchObject({
        state: "active",
        environmentId: ready.environmentId,
      });
      expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
    } finally {
      diagnostics.info.mockReset();
    }
  });

  it.each([
    { executionMode: "worker-turn", reconnect: false },
    { executionMode: "remote-exec", reconnect: false },
    { executionMode: "worker-turn", reconnect: true },
    { executionMode: "remote-exec", reconnect: true },
  ] as const)(
    "keeps a $executionMode reserve unconsumed after session hosting is disabled (reconnect=$reconnect)",
    async ({ executionMode, reconnect }) => {
      const { harness, store, ready, request, setHostingAvailable } = await preparedHarness({
        executionMode,
      });
      setHostingAvailable(false, reconnect);

      const active = await harness.service.dispatch(request);

      expect(active.environmentId).toBe(harness.ready.environmentId);
      expect(harness.environments.createWithRequest).toHaveBeenCalledOnce();
      expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
      expect(store.getCredential(ready.environmentId)?.sessionId).toBeNull();
      expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
    },
  );

  it.each(["worker-turn", "remote-exec"] as const)(
    "does not consume a %s reserve when session hosting is disabled during admission",
    async (executionMode) => {
      const {
        harness,
        store,
        ready,
        request,
        transport,
        resolveAvailability,
        setHostingAvailable,
      } = await preparedHarness({ executionMode });
      const admitted = createDeferred();
      const release = createDeferred();
      resolveAvailability.mockImplementationOnce(async () => {
        const [node] = await transport.listCurrentNodes();
        admitted.resolve();
        await release.promise;
        return { available: true, node };
      });
      const dispatch = harness.service.dispatch(request);
      try {
        await admitted.promise;
        setHostingAvailable(false);
        release.resolve();
        const active = await dispatch;

        expect(active.environmentId).toBe(harness.ready.environmentId);
        expect(harness.environments.createWithRequest).toHaveBeenCalledOnce();
        expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
        expect(store.getCredential(ready.environmentId)?.sessionId).toBeNull();
        expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await dispatch;
      }
    },
  );

  it("does not mint attachment authority after request revocation during build validation", async () => {
    const { harness, store, ready, request } = await preparedHarness();
    let authorized = true;
    vi.mocked(support.testState.prepareInstallation).mockImplementation(async () => {
      authorized = false;
      return { ...support.BUNDLE_ARTIFACT, protocolFeatures: FEATURES };
    });

    await expect(
      harness.service.dispatch(request, undefined, () => {
        if (!authorized) {
          throw new Error("request revoked");
        }
      }),
    ).rejects.toThrow("request revoked");

    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledWith(ready.environmentId);
  });

  it("uses the cold path when pool policy removes a candidate during node admission", async () => {
    const { harness, store, ready, request } = await preparedHarness();
    const candidates = vi.mocked(harness.environments.getPreparedCandidates);
    const selected = candidates.getMockImplementation()!;
    candidates.mockImplementationOnce(selected).mockReturnValue([]);

    const active = await harness.service.dispatch(request);

    expect(active.environmentId).toBe(harness.ready.environmentId);
    expect(harness.environments.createWithRequest).toHaveBeenCalledOnce();
    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
    expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
  });

  it("rejects direct attachment without the prepared placement reservation", async () => {
    const { store, workerService, ready, request } = await preparedHarness();

    await expect(
      workerService.attachSession({
        environmentId: ready.environmentId,
        ownerEpoch: ready.ownerEpoch,
        sessionId: request.sessionId,
      }),
    ).rejects.toThrow("placement reservation");

    expect(store.get(ready.environmentId)).toMatchObject({
      state: "ready",
      preparation: { consumedAtMs: null },
    });
    expect(store.getCredential(ready.environmentId)?.sessionId).toBeNull();
  });

  it("fences a profile change after node eligibility before consuming its reserve", async () => {
    const { harness, store, ready, request } = await preparedHarness();
    vi.mocked(harness.environments.assertPreparedIntentCurrent)
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error("profile changed");
      });

    await expect(harness.service.dispatch(request)).rejects.toThrow("profile changed");

    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
    expect(harness.environments.attachSession).not.toHaveBeenCalled();
    expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
  });

  it("fences workspace upload when node authority closes during prepared binding", async () => {
    const { harness, store, ready, request, revokeNode } = await preparedHarness();
    const bind = vi.mocked(harness.environments.bindPreparedWorkspace);
    const ordinaryBind = bind.getMockImplementation()!;
    bind.mockImplementation(async (binding) => {
      const prepared = await ordinaryBind(binding);
      revokeNode();
      return prepared;
    });

    await expect(harness.service.dispatch(request)).rejects.toThrow("node authority");

    expect(harness.log).not.toContain("sync");
    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
    expect(harness.environments.destroy).toHaveBeenCalledWith(ready.environmentId);
    expect(harness.environments.schedulePreparedRefill).not.toHaveBeenCalled();
  });

  it("cold provisions a pinned repository when the reserve has another base commit", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const repositoryStore = getSessionRepositoryWorkspaceStore();
    const created = await repositoryStore.create({
      agentId: REQUEST.agentId,
      sessionKey: REQUEST.sessionKey,
      url: "https://github.com/example/project.git",
      runSetupScript: false,
      assertCurrent: () => {},
    });
    const repository = await repositoryStore.bindBase({
      workspaceId: created.workspaceId,
      expectedRevision: created.revision,
      baseCommit: "e".repeat(40),
      baseManifestHash: MANIFEST_REF,
      assertCurrent: () => {},
    });
    const { harness, store, ready, request } = await preparedHarness({
      repository,
      reserveBaseCommit: "f".repeat(40),
    });
    vi.mocked(harness.environments.createWithRequest).mockRejectedValueOnce(
      new Error("cold provision selected"),
    );

    await expect(harness.service.dispatch(request)).rejects.toThrow("cold provision selected");
    expect(harness.environments.createWithRequest).toHaveBeenCalledOnce();
    expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
  });

  it.each([
    { runSetupScript: true, unpinned: false },
    { runSetupScript: false, unpinned: false },
    { runSetupScript: false, unpinned: true },
  ])(
    "claims a repository-only reserve with setup $runSetupScript, and unpinned base $unpinned",
    async ({ runSetupScript, unpinned }) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      const stagingRoot = path.join(support.testState.root, "checkpoint-source");
      await fs.mkdir(stagingRoot);
      await fs.writeFile(path.join(stagingRoot, "tracked.txt"), "pinned source\n");
      await requireWorkspaceResultGit(stagingRoot, ["init", "--quiet"]);
      await requireWorkspaceResultGit(stagingRoot, ["add", "."]);
      await requireWorkspaceResultGit(stagingRoot, [
        "-c",
        "user.name=Dispatch Fixture",
        "-c",
        "user.email=dispatch@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--quiet",
        "-m",
        "source",
      ]);
      const baseCommit = await requireWorkspaceResultGit(stagingRoot, ["rev-parse", "HEAD"]);
      const base = await captureWorkspaceManifest({ root: stagingRoot, baseCommit });
      await fs.writeFile(path.join(stagingRoot, "session.txt"), "accepted session change\n");
      const current = await captureWorkspaceManifest({ root: stagingRoot, baseCommit });
      const repositoryStore = getSessionRepositoryWorkspaceStore();
      expect(repositoryStore.path).toBe(support.testState.stateDb.path);
      const created = await repositoryStore.create({
        agentId: REQUEST.agentId,
        sessionKey: REQUEST.sessionKey,
        url: "https://github.com/example/project.git",
        requestedRef: "refs/heads/main",
        runSetupScript: !unpinned,
        assertCurrent: () => {},
      });
      if (!unpinned) {
        const pinned = await repositoryStore.bindBase({
          workspaceId: created.workspaceId,
          expectedRevision: created.revision,
          baseCommit,
          baseManifestHash: base.manifestRef,
          assertCurrent: () => {},
        });
        const staged = await stageSessionRepositoryCheckpoint({
          workspaceId: pinned.workspaceId,
          expectedRevision: pinned.revision,
          stagingRoot,
          baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
          currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
          baseManifestRef: base.manifestRef,
          currentManifestRef: current.manifestRef,
          assertCurrent: () => {},
        });
        try {
          await staged.publish();
        } finally {
          await staged.discard();
        }
      }
      const accepted = (await repositoryStore.get(created.workspaceId))!;
      const boundWorkspace = {
        workspaceDir: "/worker/prepared/project",
        sourceManifestRef: base.manifestRef,
        preparedManifestRef: base.manifestRef,
      };
      const { harness, store, ready, request } = await preparedHarness({
        repository: accepted,
        boundWorkspace,
        ...(unpinned ? { reserveBaseCommit: baseCommit } : {}),
      });
      const startTunnel = vi.mocked(harness.environments.startTunnel);
      const ordinaryTunnel = startTunnel.getMockImplementation()!;
      startTunnel.mockImplementation(async (params) => {
        const tunnel = await ordinaryTunnel(params);
        vi.spyOn(tunnel, "syncWorkspace").mockImplementation(async ({ source }) => {
          harness.log.push("sync");
          expect(source).toMatchObject({
            kind: "repository",
            url: accepted.url,
            ref: accepted.requestedRef,
            branch: accepted.branch,
            baseCommit: unpinned ? undefined : baseCommit,
            ...(unpinned ? { preparedRefMode: "fetch" } : {}),
            runSetupScript: false,
            prepared: { ...boundWorkspace, baseCommit },
          });
          if (unpinned) {
            expect(source).not.toHaveProperty("checkpoint");
          } else {
            if (source.kind !== "repository" || !source.checkpoint) {
              throw new Error("Prepared dispatch lost its accepted repository checkpoint");
            }
            expect(
              await fs.readFile(path.join(source.checkpoint.stagingRoot, "session.txt"), "utf8"),
            ).toBe("accepted session change\n");
          }
          return {
            mode: "repository",
            remoteWorkspaceDir: boundWorkspace.workspaceDir,
            baseCommit,
            baseManifestRef: base.manifestRef,
            manifestRef: current.manifestRef,
          };
        });
        if (unpinned) {
          vi.spyOn(tunnel, "reconcileWorkspace").mockImplementation(async ({ source }) => {
            if (source.kind !== "repository") {
              throw new Error("Expected repository checkpoint preparation");
            }
            const checkpoint = await source.prepareCheckpoint({
              stagingRoot,
              baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
              currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
              baseManifestRef: base.manifestRef,
              currentManifestRef: current.manifestRef,
            });
            return {
              manifestRef: current.manifestRef,
              changed: true,
              verifyStable: async () => {},
              verifyLocalStable: () => checkpoint.verify(),
              publishStagedResult: async () => {
                await checkpoint.publish();
              },
              discardPreparedStagedResult: () => checkpoint.discard(),
            };
          });
        }
        return tunnel;
      });

      const active = await harness.service.dispatch({ ...request, runSetupScript });

      expect(harness.environments.prepareProjectIntent).toHaveBeenCalledWith(request.profileId, {
        machineClass: undefined,
        os: undefined,
        executionMode: request.executionMode,
        projectPath: undefined,
        repository: {
          agentId: request.agentId,
          url: accepted.url,
          ref: accepted.requestedRef,
          baseCommit: unpinned ? undefined : baseCommit,
        },
        runSetupScript,
        inherited: undefined,
        signal: undefined,
        setupAuthorized: true,
      });
      expect(active).toMatchObject({
        state: "active",
        environmentId: ready.environmentId,
        remoteWorkspaceDir: boundWorkspace.workspaceDir,
        workspaceBaseManifestRef: current.manifestRef,
      });
      expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
      expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
      expect(harness.log.indexOf("workspace:bind-prepared")).toBeLessThan(
        harness.log.indexOf("sync"),
      );
      if (unpinned) {
        expect(harness.environments.bindPreparedWorkspace).toHaveBeenCalledOnce();
        expect(await repositoryStore.get(accepted.workspaceId)).toMatchObject({
          baseCommit,
          baseManifestHash: base.manifestRef,
          manifestHash: current.manifestRef,
          checkpointRef: expect.stringMatching(/^refs\/openclaw\/worker-results\//u),
        });
      } else {
        expect(await repositoryStore.get(accepted.workspaceId)).toEqual(accepted);
      }
      const checkpoint = await readSessionRepositoryArtifacts({
        workspaceId: accepted.workspaceId,
        assertCurrent: () => {},
      });
      expect(checkpoint.currentManifestRef).toBe(current.manifestRef);
      expect(harness.environments.schedulePreparedRefill).toHaveBeenCalledWith(ready.environmentId);
      const tunnel = await startTunnel.mock.results[0]!.value;
      expect(tunnel.quiesceWorkspace).toHaveBeenCalledTimes(unpinned ? 1 : 0);
      expect(tunnel.reconcileWorkspace).toHaveBeenCalledTimes(unpinned ? 1 : 0);
    },
  );
});
