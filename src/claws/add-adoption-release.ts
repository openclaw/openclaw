import { lstat, rmdir } from "node:fs/promises";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../agents/workspace-bootstrap-read.js";
// Adoption owns an operator-configured agent only once the final config compare-and-swap wins.
// A record kept after that swap loses claims an agent Claw never took: resume rejects the changed
// digest, remove refuses a modified agent, and a remove that did run would delete operator config
// Claw never adopted. Roll back exactly what this attempt wrote, then drop the claim.
import { clearWorkspaceBootstrapSeedMarker } from "../agents/workspace-bootstrap-seed-marker.js";
import { DEFAULT_BOOTSTRAP_FILENAME } from "../agents/workspace.js";
import { assertApplyLeaseOwned } from "./add-apply-support.js";
import {
  partialResult,
  type ClawAddApplyOptions,
  type ClawAddResult,
  type ClawCreatedWorkspaceIdentity,
} from "./add-contract.js";
import { releaseClawRemoveRows, removeClawWorkspaceFile } from "./lifecycle-delete-support.js";
import type { RemovedWorkspaceFile } from "./lifecycle-remove-types.js";
import { applyClawPackageRemovals, planClawPackageRemovals } from "./package-remove.js";
import {
  readClawPackageRefs,
  updateClawInstallRecordStatus,
  type PersistedClawInstall,
  type PersistedClawPackageRef,
} from "./provenance.js";
import type { ClawAddPlan } from "./types.js";
import {
  openClawBootstrapRemovalAuthority,
  planAdoptsWorkspace,
  readClawWorkspaceAdoption,
  type ClawBootstrapRemovalAuthority,
} from "./workspace-origin.js";
import { readClawWorkspaceFiles, type PersistedClawWorkspaceFile } from "./workspace.js";

export async function captureClawCreatedWorkspaceIdentity(
  workspace: string,
): Promise<ClawCreatedWorkspaceIdentity> {
  const stat = await lstat(workspace, { bigint: true });
  if (!stat.isDirectory() || stat.dev === 0n || stat.ino === 0n) {
    throw new Error("Created Claw workspace identity could not be verified.");
  }
  return { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
}

async function createdWorkspaceStillCurrent(
  workspace: string,
  expected: ClawCreatedWorkspaceIdentity,
): Promise<boolean> {
  const current = await lstat(workspace, { bigint: true });
  return (
    current.isDirectory() &&
    current.dev !== 0n &&
    current.ino !== 0n &&
    current.dev === expected.dev &&
    current.ino === expected.ino &&
    current.birthtimeNs === expected.birthtimeNs
  );
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function mergeWorkspaceFiles(
  persisted: PersistedClawWorkspaceFile[],
  current: PersistedClawWorkspaceFile[],
): PersistedClawWorkspaceFile[] {
  return [
    ...new Map([...persisted, ...current].map((file) => [file.path, file] as const)).values(),
  ];
}

function packageKey(pkg: PersistedClawPackageRef): string {
  return [pkg.kind, pkg.source, pkg.ref, pkg.version, pkg.integrity].join("\u0000");
}

function mergePackages(
  persisted: PersistedClawPackageRef[],
  current: PersistedClawPackageRef[],
): PersistedClawPackageRef[] {
  return [
    ...new Map([...persisted, ...current].map((pkg) => [packageKey(pkg), pkg] as const)).values(),
  ];
}

function completedWorkspaceFileRemovals(removals: RemovedWorkspaceFile[]): RemovedWorkspaceFile[] {
  return removals.filter((removal) => removal.action === "deleted" || removal.action === "missing");
}

/**
 * Releases an adoption record whose config commit never landed. Returns the paths that survived
 * rollback; while any remain, Claw still owns real state and keeps the record to clean it later.
 */
async function releaseUnclaimedClawAdoption(params: {
  plan: ClawAddPlan;
  install: PersistedClawInstall;
  workspaceFiles: PersistedClawWorkspaceFile[];
  packages: PersistedClawPackageRef[];
  rollbackBootstrap?: boolean;
  createdWorkspaceIdentity?: ClawCreatedWorkspaceIdentity;
  options: ClawAddApplyOptions;
}): Promise<{ released: boolean; retained: string[]; workspaceRemoved: boolean }> {
  assertApplyLeaseOwned(params.options);
  // This rollback happens before a removal operation exists, so there is no lifecycle journal
  // fence to revalidate or complete. The config commit itself remains serialized by add.ts.
  const noLifecycleFence = () => {};
  // A declared file that already existed with identical content was adopted, not written, so the
  // attempt owns its row but never owned its bytes. Dropping the row is the whole rollback.
  const adoptedPaths = new Set(
    params.plan.actions
      .filter((action) => action.kind === "workspaceFile" && action.action === "adopt")
      .map((action) => action.id),
  );
  const workspaceOrigin = planAdoptsWorkspace(params.plan)
    ? readClawWorkspaceAdoption(params.install.agentId, params.install.workspace, params.options)
    : { adopted: false as const };
  const removals: RemovedWorkspaceFile[] = [];
  let workspaceRemoved = false;
  let createdWorkspaceCurrent = true;
  if (params.createdWorkspaceIdentity) {
    try {
      assertApplyLeaseOwned(params.options);
      createdWorkspaceCurrent = await createdWorkspaceStillCurrent(
        params.install.workspace,
        params.createdWorkspaceIdentity,
      );
    } catch (error) {
      if (isMissingPathError(error)) {
        createdWorkspaceCurrent = false;
        workspaceRemoved = true;
      } else {
        const retained = [params.install.workspace];
        releaseClawRemoveRows(
          params.install.agentId,
          [],
          retained,
          noLifecycleFence,
          noLifecycleFence,
          params.options,
          true,
        );
        return { released: false, retained, workspaceRemoved: false };
      }
    }
    assertApplyLeaseOwned(params.options);
  }
  for (const file of params.workspaceFiles) {
    assertApplyLeaseOwned(params.options);
    if (!createdWorkspaceCurrent || adoptedPaths.has(file.path)) {
      removals.push({ path: file.path, action: "missing" });
    } else if (workspaceOrigin.adopted) {
      const authority = openClawBootstrapRemovalAuthority({
        workspace: params.install.workspace,
        relativePath: file.path,
        publication: workspaceOrigin.filePublications?.[file.path],
      });
      try {
        removals.push(
          authority.owned
            ? await removeClawWorkspaceFile(
                { ...file, state: "unchanged" },
                noLifecycleFence,
                undefined,
                authority.ownsFile,
              )
            : {
                path: file.path,
                action: authority.missing ? "missing" : "retainedUnowned",
              },
        );
      } finally {
        if (authority.owned) {
          authority.close();
        }
      }
    } else {
      removals.push(
        await removeClawWorkspaceFile({ ...file, state: "unchanged" }, noLifecycleFence),
      );
    }
    assertApplyLeaseOwned(params.options);
  }
  let bootstrapRemoval: RemovedWorkspaceFile | undefined;
  if (params.rollbackBootstrap !== false && params.install.bootstrap) {
    assertApplyLeaseOwned(params.options);
    let authority: ClawBootstrapRemovalAuthority | undefined;
    if (!createdWorkspaceCurrent) {
      bootstrapRemoval = { path: DEFAULT_BOOTSTRAP_FILENAME, action: "missing" };
    } else if (workspaceOrigin.adopted) {
      authority = openClawBootstrapRemovalAuthority({
        workspace: params.install.workspace,
        relativePath: DEFAULT_BOOTSTRAP_FILENAME,
        publication: workspaceOrigin.bootstrapPublication,
      });
    }
    try {
      if (!bootstrapRemoval) {
        bootstrapRemoval =
          authority && !authority.owned && !authority.missing
            ? { path: DEFAULT_BOOTSTRAP_FILENAME, action: "retainedUnowned" }
            : await removeClawWorkspaceFile(
                {
                  workspace: params.install.workspace,
                  path: DEFAULT_BOOTSTRAP_FILENAME,
                  contentDigest: params.install.bootstrap.contentDigest,
                  state: "unchanged",
                },
                noLifecycleFence,
                MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
                authority?.owned ? authority.ownsFile : authority ? () => false : undefined,
              );
      }
    } finally {
      if (authority?.owned) {
        authority.close();
      }
    }
    assertApplyLeaseOwned(params.options);
    removals.push(bootstrapRemoval);
  }
  // The seed marker and the file are one fact. Deleting the file while the marker stands makes the
  // next seed read "already seeded, file gone" as consumed and write nothing at all.
  if (
    (bootstrapRemoval?.action === "deleted" || bootstrapRemoval?.action === "missing") &&
    (createdWorkspaceCurrent || workspaceRemoved) &&
    (!workspaceOrigin.adopted || workspaceOrigin.bootstrapPublication)
  ) {
    clearWorkspaceBootstrapSeedMarker(
      params.install.workspace,
      params.options.nowMs ?? Date.now(),
      params.options,
    );
  }
  const retained = removals
    .filter(
      (removal) =>
        removal.action === "retainedModified" ||
        removal.action === "retainedUnowned" ||
        removal.action === "error",
    )
    .map((removal) => removal.path);
  if (retained.length === 0 && params.createdWorkspaceIdentity && createdWorkspaceCurrent) {
    let workspaceStillOwned = false;
    try {
      assertApplyLeaseOwned(params.options);
      workspaceStillOwned = await createdWorkspaceStillCurrent(
        params.install.workspace,
        params.createdWorkspaceIdentity,
      );
    } catch (error) {
      workspaceRemoved = isMissingPathError(error);
      if (!workspaceRemoved) {
        retained.push(params.install.workspace);
      }
    }
    assertApplyLeaseOwned(params.options);
    // A proven replacement belongs to the operator. A workspace whose original identity remains
    // is still this attempt's cleanup responsibility until it is actually removed.
    if (workspaceStillOwned) {
      try {
        assertApplyLeaseOwned(params.options);
        await rmdir(params.install.workspace);
        workspaceRemoved = true;
      } catch (error) {
        workspaceRemoved = isMissingPathError(error);
        if (!workspaceRemoved) {
          retained.push(params.install.workspace);
        }
      }
      assertApplyLeaseOwned(params.options);
    }
  }
  // Stop before the packages when a file survived: half-uninstalling what the retained record
  // still claims would leave ownership describing state that is already gone.
  if (retained.length > 0) {
    releaseClawRemoveRows(
      params.install.agentId,
      completedWorkspaceFileRemovals(removals),
      retained,
      noLifecycleFence,
      noLifecycleFence,
      params.options,
      true,
    );
    return { released: false, retained, workspaceRemoved };
  }
  if (params.packages.length > 0) {
    assertApplyLeaseOwned(params.options);
    const decisions = await planClawPackageRemovals(
      params.install,
      params.packages,
      params.options,
    );
    assertApplyLeaseOwned(params.options);
    const outcome = await applyClawPackageRemovals(decisions, params.options);
    assertApplyLeaseOwned(params.options);
    // A referenced package another Claw still owns stays installed; only a failed uninstall
    // leaves state this attempt cannot account for.
    retained.push(
      ...outcome.packages
        .filter((result) => result.action === "error")
        .map((result) => `${result.kind}:${result.ref}`),
    );
  }
  if (retained.length > 0) {
    releaseClawRemoveRows(
      params.install.agentId,
      completedWorkspaceFileRemovals(removals),
      retained,
      noLifecycleFence,
      noLifecycleFence,
      params.options,
      true,
    );
    return { released: false, retained, workspaceRemoved };
  }
  // Adopted state was never Claw-created, so its durable agent-database registration is not this
  // attempt's to unregister.
  releaseClawRemoveRows(
    params.install.agentId,
    removals,
    [],
    noLifecycleFence,
    noLifecycleFence,
    params.options,
    true,
  );
  return { released: true, retained: [], workspaceRemoved };
}

/** Shapes a failed pre-claim adoption after releasing every effect that can still be reversed. */
export async function releaseUncommittedAgentAdoption(params: {
  plan: ClawAddPlan;
  install: PersistedClawInstall;
  workspaceFiles: PersistedClawWorkspaceFile[];
  packages: PersistedClawPackageRef[];
  workspaceCreated: boolean;
  createdWorkspaceIdentity?: ClawCreatedWorkspaceIdentity;
  configCommitted: boolean;
  rollbackWorkspaceEffects: boolean;
  error: NonNullable<ClawAddResult["error"]>;
  options: ClawAddApplyOptions;
}): Promise<ClawAddResult> {
  assertApplyLeaseOwned(params.options);
  // A resumed attempt can fail before this invocation has replayed its workspace or package
  // phases. Include the durable effects from the earlier invocation so releasing the install
  // record cannot orphan their rows or bytes.
  const persistedWorkspaceFiles = readClawWorkspaceFiles(params.install.agentId, params.options);
  const workspaceFiles = mergeWorkspaceFiles(
    persistedWorkspaceFiles,
    params.rollbackWorkspaceEffects ? params.workspaceFiles : [],
  );
  const packages = mergePackages(
    readClawPackageRefs({ ...params.options, agentId: params.install.agentId }),
    params.packages,
  );
  const release = await releaseUnclaimedClawAdoption({
    plan: params.plan,
    install: params.install,
    workspaceFiles,
    packages,
    rollbackBootstrap: params.rollbackWorkspaceEffects,
    createdWorkspaceIdentity: planAdoptsWorkspace(params.plan)
      ? undefined
      : params.createdWorkspaceIdentity,
    options: params.options,
  });
  const released = release.released;
  if (!released) {
    (params.options.updateRecord ?? updateClawInstallRecordStatus)(
      params.plan.agent.finalId,
      "partial",
      {
        ...params.options,
        expectedStatuses: ["pending", "workspace_ready", "partial"],
      },
    );
  }
  const retainedWorkspaceFiles = released
    ? []
    : workspaceFiles.filter((file) => release.retained.includes(file.path));
  const retainedPackages = released
    ? []
    : packages.filter((entry) => release.retained.includes(`${entry.kind}:${entry.ref}`));
  const note = released
    ? release.workspaceRemoved
      ? ` Claw released its unclaimed adoption of agent ${JSON.stringify(params.plan.agent.finalId)} and removed the empty workspace it created.`
      : ` Claw released its unclaimed adoption of agent ${JSON.stringify(params.plan.agent.finalId)}; the agent and its workspace were left as they are.`
    : ` Claw still owns ${release.retained.join(", ")}; restore agent ${JSON.stringify(params.plan.agent.finalId)} to its recorded configuration, then preview again to retry or remove.`;
  return partialResult({
    plan: params.plan,
    installRecord: released ? undefined : params.install,
    workspaceCreated: params.workspaceCreated && !release.workspaceRemoved,
    configCommitted: params.configCommitted,
    workspaceFiles: retainedWorkspaceFiles,
    packages: retainedPackages,
    installStatus: "partial",
    error: { ...params.error, message: `${params.error.message}${note}` },
    nowMs: params.options.nowMs,
  });
}
