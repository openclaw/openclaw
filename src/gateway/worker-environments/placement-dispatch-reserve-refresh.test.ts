import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { requireGit } from "../../agents/worktrees/git.js";
import { NodeWorkerPreparedWorkspaceRuntime } from "../../node-host/node-worker-prepared-workspace.js";
import type { WorkerProvider } from "../../plugins/types.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { sessionLog } from "../session-log.js";
import { FEATURES, preparedHarness } from "./placement-dispatch-prepared.test-support.js";
import { createWorkerPreparationIdentity } from "./preparation-identity.js";
import type { WorkerProjectPreparationIdentity } from "./preparation-identity.schema.js";
import { createProjectPreparationFixture } from "./project-preparation.test-support.js";
import * as support from "./service.test-support.js";
import { prepareWorkerProjectSnapshot, type WorkerProjectSnapshot } from "./workspace-git-base.js";

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  getRuntimeConfig: () => ({
    gateway: { nodes: { commands: { allow: ["codex.exec-server.stdio.v1"] } } },
  }),
}));

const profile = { settings: { region: "test" }, executionMode: "worker-turn" as const };
const target = { machineClass: "standard", platform: "linux", arch: "x64" };
const identityFor = (
  project: WorkerProjectSnapshot,
  overrides: Partial<Parameters<typeof createWorkerPreparationIdentity>[0]> = {},
) =>
  createWorkerPreparationIdentity({
    namespace: "gateway",
    providerId: "fake",
    profileId: "development",
    profileSnapshot: profile,
    project,
    target,
    artifacts: {
      nodeBootstrapSha256: "f".repeat(64),
      enabledPluginIds: [],
      workerBundleHash: support.BUNDLE_HASH,
      workerArchiveSha256: "b".repeat(64),
      openclawVersion: support.BOOTSTRAP_RECEIPT.openclawVersion,
      protocolFeatures: FEATURES,
    },
    ...overrides,
  });
const intentFor = (project: WorkerProjectSnapshot, preparation = identityFor(project)) => ({
  providerId: "fake",
  profileSnapshot: { ...profile, project: { ...project, preparation } },
});

async function refreshFixture(failRefresh = false) {
  const directory = path.join(support.testState.root, "project");
  await fs.mkdir(directory);
  const source = await createProjectPreparationFixture(directory);
  const preparation = identityFor(source.project);
  const initial = await source.preparedOperation(undefined, {
    key: preparation.key,
    cacheKey: preparation.cacheKey,
  });
  const preparedA = (await initial.project.prepare(source)).preparedWorkspace!;
  initial.close();
  const env = {
    ...process.env,
    HOME: source.home,
    OPENCLAW_STATE_DIR: path.join(directory, "state"),
  };
  const runtime = new NodeWorkerPreparedWorkspaceRuntime(source.home, { env }, new Map(), true);
  onTestFinished(async () => {
    await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
  });
  const provision = vi.fn<WorkerProvider["provision"]>(async () => {
    throw new Error("Unexpected new lease during reserve adoption");
  });
  const refresh = vi.fn<NonNullable<WorkerProvider["refreshPreparedProject"]>>(
    async (_lease, project) => {
      if (failRefresh) {
        throw new Error("synthetic checkout refresh failure");
      }
      await project.prepare(source);
    },
  );
  const provider = support.createProvider({
    requiresNodeEnrollment: true,
    supportedExecutionModes: ["worker-turn"],
    supportsProjectPreparation: () => true,
    resolvePreparationTarget: () => target,
    provision,
    refreshPreparedProject: refresh,
  });
  const fixture = await preparedHarness({
    project: source.project,
    preparation,
    provider,
    serviceOptions: {
      projectNamespace: "gateway",
      registerPreparedWorkspace: async ({ record, workspace, assertCurrent }) => {
        assertCurrent();
        await runtime.prepare({
          action: "register",
          gatewayNamespace: "gateway",
          environmentId: record.environmentId,
          ...workspace,
        });
        assertCurrent();
      },
      bindPreparedWorkspace: async ({ assertCurrent, signal, ...binding }) => {
        assertCurrent();
        return runtime.prepare({ action: "bind", gatewayNamespace: "gateway", ...binding }, signal);
      },
    },
  });
  await runtime.prepare({
    action: "register",
    gatewayNamespace: "gateway",
    environmentId: fixture.ready.environmentId,
    ...preparedA,
  });
  fixture.harness.environments.refreshPreparedEnvironment =
    fixture.workerService.refreshPreparedEnvironment;
  vi.mocked(fixture.harness.environments.getPreparedCandidates).mockImplementation(
    fixture.workerService.getPreparedCandidates,
  );
  vi.mocked(fixture.harness.environments.bindPreparedWorkspace).mockImplementation(
    fixture.workerService.bindPreparedWorkspace,
  );
  await fs.writeFile(path.join(source.repository, "input.txt"), "requested commit B\n");
  await requireGit(source.repository, ["commit", "--quiet", "-am", "B"]);
  const projectB = (await prepareWorkerProjectSnapshot({
    localPath: source.repository,
    namespace: "gateway",
  }))!;
  const intentB = intentFor(projectB);
  vi.mocked(fixture.harness.environments.prepareProjectIntent).mockResolvedValue(intentB);
  return {
    ...fixture,
    source,
    projectB,
    intentB,
    preparedA,
    runtime,
    provision,
    refresh,
    provider,
  };
}

describe("ready reserve refresh during dispatch", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("adopts A for B without allocating and republishes B before the node binds", async () => {
    const f = await refreshFixture();
    const info = vi.spyOn(sessionLog, "info").mockImplementation(() => {});
    const placement = await f.harness.service.dispatch(f.request);

    expect(placement).toMatchObject({ state: "active", environmentId: f.ready.environmentId });
    expect(f.harness.environments.createWithRequest).not.toHaveBeenCalled();
    expect(f.provision).not.toHaveBeenCalled();
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.refresh.mock.calls[0]?.[0]).toMatchObject({ leaseId: f.ready.leaseId });
    expect(await requireGit(f.preparedA.workspaceDir, ["rev-parse", "HEAD"])).toBe(
      f.projectB.baseCommit,
    );
    expect(await fs.readFile(path.join(f.preparedA.workspaceDir, "input.txt"), "utf8")).toBe(
      "requested commit B\n",
    );
    const baseline = await f.runtime.store!.find(f.ready.environmentId);
    expect(baseline).toMatchObject({ state: "bound", session_id: f.request.sessionId });
    expect(baseline?.source_manifest_ref).not.toBe(f.preparedA.sourceManifestRef);
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(
          f.preparedA.homeDir,
          ".openclaw-worker/manifests",
          `${baseline!.source_manifest_ref.slice(7)}.json`,
        ),
        "utf8",
      ),
    );
    expect(manifest.baseCommit).toBe(f.projectB.baseCommit);
    expect(f.store.get(f.ready.environmentId)?.profileSnapshot.project).toMatchObject({
      baseCommit: f.projectB.baseCommit,
    });
    expect(info).toHaveBeenCalledWith("Prepared worker adopted", {
      mode: "refreshed",
      elapsedMs: expect.any(Number),
    });
  });

  it("retains profile, recipe, runtime and repository isolation and prefers exact commits", async () => {
    const f = await refreshFixture();
    const incompatible: WorkerProjectPreparationIdentity[] = [
      identityFor(f.projectB, { profileId: "other-profile" }),
      identityFor(f.projectB, { setupRecipe: "a".repeat(40) }),
      identityFor(f.projectB, {
        artifacts: { ...identityFor(f.projectB).artifacts, workerBundleHash: "0".repeat(64) },
      }),
      identityFor({ ...f.projectB, key: "0".repeat(64) }),
    ];
    for (const preparation of incompatible) {
      expect(f.workerService.getPreparedCandidates(intentFor(f.projectB, preparation))).toEqual([]);
    }
    expect(
      f.workerService.getPreparedCandidates(f.intentB).map((row) => row.environmentId),
    ).toEqual([f.ready.environmentId]);
    const exact = await f.store.createIntent({
      environmentId: "exact-reserve",
      profileId: f.ready.profileId,
      providerId: "fake",
      profileSnapshot: f.intentB.profileSnapshot,
      provisionOperationId: "exact-reserve",
      preparation: {
        purpose: "reserve",
        key: identityFor(f.projectB).key,
        demandAtMs: 900,
        expiresAtMs: 10_000,
      },
    });
    await f.store.transition({
      environmentId: exact.environmentId,
      from: "requested",
      to: "provisioning",
    });
    await f.store.transition({
      environmentId: exact.environmentId,
      from: "provisioning",
      to: "ready",
      patch: {
        leaseId: "exact-lease",
        nodeDeviceId: "exact-node",
        sharedHost: false,
        ...support.readyPatch(exact.environmentId, {
          ...support.BOOTSTRAP_RECEIPT,
          protocolFeatures: FEATURES,
        }),
      },
    });
    expect(
      f.workerService.getPreparedCandidates(f.intentB).map((row) => row.environmentId),
    ).toEqual([exact.environmentId, f.ready.environmentId]);
    delete f.provider.refreshPreparedProject;
    expect(
      f.workerService.getPreparedCandidates(f.intentB).map((row) => row.environmentId),
    ).toEqual([exact.environmentId]);
    expect(f.store.get(f.ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
  });

  it("retires a failed refresh and completes dispatch through the normal path", async () => {
    const f = await refreshFixture(true);
    const warn = vi.spyOn(sessionLog, "warn").mockImplementation(() => {});
    const placement = await f.harness.service.dispatch({
      ...f.request,
      idempotencyKey: `session-dispatch:${f.request.sessionId}:1`,
    });

    expect(placement.state).toBe("active");
    expect(placement.environmentId).not.toBe(f.ready.environmentId);
    expect(f.refresh).toHaveBeenCalledOnce();
    expect(f.harness.environments.createWithRequest).toHaveBeenCalledOnce();
    expect(f.harness.environments.destroy).toHaveBeenCalledWith(f.ready.environmentId);
    expect(f.store.get(f.ready.environmentId)?.state).toBe("destroyed");
    expect((await f.runtime.store!.find(f.ready.environmentId))?.state).toBe("available");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("synthetic checkout refresh failure"),
    );
  });

  it.each(["abort", "authority"])("does not fall back after refresh loses %s", async (loss) => {
    const f = await refreshFixture();
    const abort = new AbortController();
    let authorized = true;
    f.refresh.mockImplementation(async () => {
      await Promise.resolve();
      if (loss === "abort") {
        abort.abort(new Error("synthetic dispatch aborted"));
      } else {
        authorized = false;
      }
      throw new Error("synthetic refresh interrupted");
    });
    await expect(
      f.harness.service.dispatch(
        f.request,
        undefined,
        () => {
          if (!authorized) {
            throw new Error("synthetic dispatch authority revoked");
          }
        },
        abort.signal,
      ),
    ).rejects.toThrow(/synthetic dispatch (aborted|authority revoked)/);
    expect(f.harness.environments.createWithRequest).not.toHaveBeenCalled();
    expect(f.harness.environments.attachSession).not.toHaveBeenCalled();
  });
});
