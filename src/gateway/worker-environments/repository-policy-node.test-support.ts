import fs from "node:fs/promises";
import path from "node:path";
import { onTestFinished } from "vitest";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import { stageSessionRepositoryCheckpoint } from "./session-repository-checkpoints.js";
import type { WorkerEnvironmentStore } from "./store.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { requireWorkspaceResultGit } from "./workspace-result-git.js";

const { writeManagedGitHubProfileFiles, resolveManagedGitHubProfileDir } =
  await loadBundledPluginFacade<{
    writeManagedGitHubProfileFiles(
      profileDir: string,
      identity: { login: string; token: string },
      options?: { assertCurrent: () => void },
    ): Promise<void>;
    resolveManagedGitHubProfileDir(params: {
      agentId: string;
      scope: "system" | "agent" | "personal";
      profileId: string;
      env?: NodeJS.ProcessEnv;
    }): string;
  }>({ pluginId: "github-repositories", artifactBasename: "runtime-api.ts" });

/** Synthetic credentials in the native managed-profile file contract, shared by source and image proof. */
export async function createManagedRepositoryProfile(params: {
  agentId: string;
  profileId: string;
  stateDir: string;
  token: string;
}) {
  const profileDir = resolveManagedGitHubProfileDir({
    agentId: params.agentId,
    scope: "system",
    profileId: params.profileId,
    env: { OPENCLAW_STATE_DIR: params.stateDir },
  });
  await writeManagedGitHubProfileFiles(profileDir, {
    login: "managed-fixture",
    token: params.token,
  });
}

/** Unprepared node runtime and real HTTP transfer, with the durable environment owner. */
export async function createRepositoryNodeFixture({
  nodeHome,
  store,
}: {
  nodeHome: string;
  store: WorkerEnvironmentStore;
}) {
  const env = { ...process.env, HOME: nodeHome, OPENCLAW_STATE_DIR: path.join(nodeHome, "state") };
  const runtime = new NodeWorkerWorkspaceRuntime({ env, ephemeral: true });
  const workspaceTransfer = createNodeWorkspaceTransferService({
    temporaryRoot: path.join(nodeHome, "transfers"),
    getOwner: (environmentId) => {
      const environment = store.get(environmentId);
      return environment
        ? { credential: store.getCredential(environmentId), environment }
        : undefined;
    },
  });
  const server = await startNodeWorkspaceTransferTestServer(workspaceTransfer);
  onTestFinished(async () => {
    await server.close();
    await workspaceTransfer.closeAll();
    await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(env));
  });
  return { runtime, workspaceTransfer, gatewayUrl: server.gatewayUrl };
}

/** Actual prepared-node storage and HTTP checkpoint transport; no caller authority is fabricated here. */
export async function createPreparedRepositoryNodeFixture(params: {
  nodeHome: string;
  workspaceDir: string;
  base: Awaited<ReturnType<typeof captureWorkspaceManifest>>;
  store: WorkerEnvironmentStore;
  identity: {
    gatewayNamespace: string;
    environmentId: string;
    preparationKey: string;
    cacheKey: string;
  };
}) {
  const { nodeHome, workspaceDir, base, store, identity } = params;
  const homeDir = path.join(path.dirname(workspaceDir), "home");
  const manifests = path.join(homeDir, ".openclaw-worker", "manifests");
  await fs.mkdir(manifests, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(manifests, base.manifestRef.slice(7) + ".json"),
    serializeWorkerWorkspaceManifest(base.manifest),
  );
  const node = await createRepositoryNodeFixture({ nodeHome, store });
  await node.runtime.prepare({
    action: "register",
    ...identity,
    workspaceDir,
    homeDir,
    sourceManifestRef: base.manifestRef,
    preparedManifestRef: base.manifestRef,
  });
  return node;
}

export async function createRepositoryPolicySource(stagingRoot: string) {
  await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
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
  return { baseCommit, base };
}

/** A real accepted checkpoint consumed by prepared-node admission and history tests. */
export async function createAcceptedPreparedRepositorySource({
  stagingRoot,
  agentId,
  sessionKey,
}: {
  stagingRoot: string;
  agentId: string;
  sessionKey: string;
}) {
  const { baseCommit, base } = await createRepositoryPolicySource(stagingRoot);
  await fs.writeFile(path.join(stagingRoot, "session.txt"), "accepted session change\n");
  const current = await captureWorkspaceManifest({ root: stagingRoot, baseCommit });
  const repositoryStore = getSessionRepositoryWorkspaceStore();
  const created = await repositoryStore.create({
    agentId,
    sessionKey,
    url: "https://github.com/example/project.git",
    requestedRef: "refs/heads/main",
    runSetupScript: true,
    assertCurrent: () => {},
  });
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
  const accepted = (await repositoryStore.get(created.workspaceId))!;
  const boundWorkspace = {
    workspaceDir: stagingRoot,
    sourceManifestRef: base.manifestRef,
    preparedManifestRef: base.manifestRef,
  };
  return { baseCommit, base, current, repositoryStore, accepted, boundWorkspace };
}

export const PREPARED_REPOSITORY_ADMISSION_CASES = [
  { sourceCase: "legacy unqualified source with setup", runSetupScript: true },
  { sourceCase: "legacy unqualified source without setup", runSetupScript: false },
  {
    sourceCase: "automatically selected source",
    runSetupScript: false,
    preparedRepositorySourceId: "forge-a/repositories",
  },
  {
    sourceCase: "matching explicit source",
    runSetupScript: false,
    repositorySourceId: "forge-a/repositories",
    preparedRepositorySourceId: "forge-a/repositories",
  },
  {
    sourceCase: "different explicit source",
    runSetupScript: false,
    repositorySourceId: "forge-b/repositories",
    preparedRepositorySourceId: "forge-a/repositories",
    rejectSource: true,
  },
  { sourceCase: "forbidden policy", scenario: "forbidden", runSetupScript: false },
  {
    sourceCase: "policy revoked after checkpoint",
    scenario: "revoked-after-checkpoint",
    runSetupScript: false,
  },
  {
    sourceCase: "policy revoked before command",
    scenario: "revoked-before-command",
    runSetupScript: false,
  },
];
