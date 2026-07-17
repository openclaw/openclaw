import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { findOverlappingWorkspaceAgentIds } from "../agents/agent-delete-safety.js";
import { stableStringify } from "../agents/stable-stringify.js";
import {
  prepareLegacyWorkspaceStateReset,
  removeLegacyWorkspaceStateForReset,
} from "../agents/workspace-legacy-state.js";
import {
  deleteWorkspaceState,
  prepareWorkspaceStateDeletion,
} from "../agents/workspace-state-store.js";
import { moveToTrash } from "../commands/onboard-helpers.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { deleteAgentConfigEntry } from "../gateway/server-methods/agents-config-mutations.js";
import { root as fsSafeRoot, FsSafeError } from "../infra/fs-safe.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  clawRemoveQuietRuntime,
  deletionEffects,
  readAllClawWorkspaceFiles,
  synthesizeOrphanInstall,
} from "./lifecycle-delete-support.js";
import {
  applyClawPackageRemovals,
  inspectClawPackage,
  planClawPackageRemovals,
  type ClawPackageInspection,
  type ClawPackageRemovalResult,
  type PackageRemovalDeps,
} from "./package-remove.js";
import {
  readClawInstallRecords,
  readClawPackageRefs,
  updateClawInstallRecordStatus,
  type PersistedClawInstall,
} from "./provenance.js";
import { CLAW_OUTPUT_STABILITY } from "./types.js";
import { readClawWorkspaceFiles, type PersistedClawWorkspaceFile } from "./workspace.js";

const CLAW_STATUS_SCHEMA_VERSION = "openclaw.clawStatus.v1" as const;
export const CLAW_REMOVE_PLAN_SCHEMA_VERSION = "openclaw.clawRemovePlan.v1" as const;
export const CLAW_REMOVE_RESULT_SCHEMA_VERSION = "openclaw.clawRemoveResult.v1" as const;
const MAX_FILE_BYTES = 1024 * 1024;

type ClawManagedFileStatus = PersistedClawWorkspaceFile & {
  state: "unchanged" | "modified" | "missing" | "unsafe";
  message?: string;
};
type ClawStatusRecord = {
  install: PersistedClawInstall;
  orphaned?: boolean;
  agentState: "present" | "modified" | "missing";
  workspaceFiles: ClawManagedFileStatus[];
  packages: ClawPackageInspection[];
};
type ClawStatusResult = {
  schemaVersion: typeof CLAW_STATUS_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  target?: string;
  records: ClawStatusRecord[];
  summary: {
    claws: number;
    partial: number;
    missingAgents: number;
    driftedFiles: number;
    packageRefs: number;
    missingPackages: number;
    driftedPackages: number;
    incompletePackages: number;
  };
};
type ClawRemovePlanAction = {
  kind:
    | "agent"
    | "configBinding"
    | "agentAllow"
    | "workspace"
    | "agentState"
    | "sessionTranscripts"
    | "workspaceFile"
    | "packageRef"
    | "installRecord";
  id: string;
  action: "remove" | "delete" | "retain" | "release" | "uninstall" | "trash";
  target: string;
  blocked: boolean;
  reason?: string;
  details?: Record<string, unknown>;
};
type ClawRemovePlan = {
  schemaVersion: typeof CLAW_REMOVE_PLAN_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: true;
  mutationAllowed: false;
  planIntegrity: string;
  target: string;
  agentId?: string;
  actions: ClawRemovePlanAction[];
  blockers: Array<{ code: string; message: string }>;
};
type RemovedWorkspaceFile = {
  path: string;
  action: "deleted" | "missing" | "retainedModified" | "error";
  message?: string;
};
type ClawRemoveResult = {
  schemaVersion: typeof CLAW_REMOVE_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: false;
  status: "complete" | "partial";
  agentId: string;
  agentRemoved: boolean;
  workspaceFiles: RemovedWorkspaceFile[];
  packages: ClawPackageRemovalResult[];
  packageRefsReleased: number;
  error?: { code: string; message: string };
};

export class ClawRemoveError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ClawRemoveError";
  }
}

function digestAgent(
  agent: NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number],
): string {
  return `sha256:${createHash("sha256").update(stableStringify(agent)).digest("hex")}`;
}

async function inspectFile(record: PersistedClawWorkspaceFile): Promise<ClawManagedFileStatus> {
  try {
    const workspace = await fsSafeRoot(record.workspace, {
      hardlinks: "reject",
      maxBytes: MAX_FILE_BYTES,
      symlinks: "reject",
    });
    if (!(await workspace.exists(record.path))) {
      return { ...record, state: "missing" };
    }
    const content = await workspace.readBytes(record.path, { maxBytes: MAX_FILE_BYTES });
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    return { ...record, state: digest === record.contentDigest ? "unchanged" : "modified" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...record, state: "missing" };
    }
    return {
      ...record,
      state: "unsafe",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readClawStatus(
  target?: string,
  options: OpenClawStateDatabaseOptions & {
    config?: OpenClawConfig;
    packageDeps?: PackageRemovalDeps;
  } = {},
): Promise<ClawStatusResult> {
  const config = options.config ?? getRuntimeConfig();
  const allInstalls = readClawInstallRecords(options);
  const installAgentIds = new Set(allInstalls.map((install) => install.agentId));
  const allPackageRefs = readClawPackageRefs(options);
  const allWorkspaceFiles = readAllClawWorkspaceFiles(options);
  const orphanAgentIds = new Set<string>();
  for (const packageRef of allPackageRefs) {
    if (!installAgentIds.has(packageRef.agentId)) {
      orphanAgentIds.add(packageRef.agentId);
    }
  }
  for (const file of allWorkspaceFiles) {
    if (!installAgentIds.has(file.agentId)) {
      orphanAgentIds.add(file.agentId);
    }
  }
  const orphanInstalls = [...orphanAgentIds].map((agentId) => {
    const packageRef = allPackageRefs.find((candidate) => candidate.agentId === agentId);
    const file = allWorkspaceFiles.find((candidate) => candidate.agentId === agentId);
    return synthesizeOrphanInstall({
      agentId,
      clawName: packageRef?.clawName,
      workspace: file?.workspace,
      updatedAtMs: Math.max(packageRef?.updatedAtMs ?? 0, file?.updatedAtMs ?? 0),
    });
  });
  const installs = [...allInstalls, ...orphanInstalls].filter(
    (install) => !target || install.agentId === target || install.claw.name === target,
  );
  const records: ClawStatusRecord[] = [];
  for (const install of installs) {
    const agent = config.agents?.list?.find((candidate) => candidate.id === install.agentId);
    const packageRefs = allPackageRefs.filter(
      (packageRef) => packageRef.agentId === install.agentId,
    );
    const workspaceFiles = installAgentIds.has(install.agentId)
      ? readClawWorkspaceFiles(install.agentId, options)
      : allWorkspaceFiles.filter((file) => file.agentId === install.agentId);
    records.push({
      install,
      ...(installAgentIds.has(install.agentId) ? {} : { orphaned: true }),
      agentState: !agent
        ? "missing"
        : digestAgent(agent) === install.agentConfigDigest
          ? "present"
          : "modified",
      workspaceFiles: await Promise.all(workspaceFiles.map(inspectFile)),
      packages: await Promise.all(
        packageRefs.map((packageRef) =>
          inspectClawPackage(install, packageRef, options.packageDeps),
        ),
      ),
    });
  }
  return {
    schemaVersion: CLAW_STATUS_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    ...(target ? { target } : {}),
    records,
    summary: {
      claws: records.length,
      partial: records.filter((record) => record.install.status === "partial").length,
      missingAgents: records.filter((record) => record.agentState === "missing").length,
      driftedFiles: records
        .flatMap((record) => record.workspaceFiles)
        .filter((file) => file.state !== "unchanged").length,
      packageRefs: records.flatMap((record) => record.packages).length,
      missingPackages: records
        .flatMap((record) => record.packages)
        .filter((pkg) => pkg.state === "missing").length,
      driftedPackages: records
        .flatMap((record) => record.packages)
        .filter((pkg) => pkg.state === "modified" || pkg.state === "ambiguous").length,
      incompletePackages: records
        .flatMap((record) => record.packages)
        .filter((pkg) => pkg.state === "incomplete").length,
    },
  };
}

export async function buildClawRemovePlan(
  target: string,
  options: OpenClawStateDatabaseOptions & {
    config?: OpenClawConfig;
    packageDeps?: PackageRemovalDeps;
  } = {},
): Promise<ClawRemovePlan> {
  const status = await readClawStatus(target, options);
  const blockers: ClawRemovePlan["blockers"] = [];
  if (status.records.length === 0) {
    blockers.push({
      code: "claw_not_found",
      message: `No installed Claw matches ${JSON.stringify(target)}.`,
    });
  } else if (status.records.length > 1) {
    blockers.push({
      code: "claw_ambiguous",
      message: `Claw name ${JSON.stringify(target)} matches multiple agents; use an agent id.`,
    });
  }
  const record = status.records.length === 1 ? status.records[0] : undefined;
  if (record?.agentState === "modified") {
    blockers.push({
      code: "agent_modified",
      message: `Agent ${JSON.stringify(record.install.agentId)} changed after add.`,
    });
  }
  for (const file of record?.workspaceFiles ?? []) {
    if (file.state === "unsafe") {
      blockers.push({
        code: "workspace_file_unsafe",
        message: `${file.path}: ${file.message ?? "unsafe file"}`,
      });
    }
  }
  const actions: ClawRemovePlanAction[] = [];
  if (record) {
    const packageDecisions = await planClawPackageRemovals(record.install, record.packages, {
      ...options,
      deps: options.packageDeps,
    });
    const effects = deletionEffects(options.config ?? getRuntimeConfig(), record.install.agentId);
    actions.push({
      kind: "agent",
      id: record.install.agentId,
      action: "remove",
      target: `agents.list[${record.install.agentId}]`,
      blocked: record.agentState === "modified",
      details: {
        expectedState: record.agentState,
        configDigest: record.install.agentConfigDigest,
        ownedPaths: record.install.agentOwnedPaths,
      },
      ...(record.agentState === "modified" ? { reason: "Agent config digest changed." } : {}),
    });
    if (effects.pruned.removedBindings > 0) {
      actions.push({
        kind: "configBinding",
        id: record.install.agentId,
        action: "remove",
        target: `bindings[agentId=${record.install.agentId}]`,
        blocked: record.agentState === "modified",
        details: { count: effects.pruned.removedBindings },
      });
    }
    if (effects.pruned.removedAllow > 0) {
      actions.push({
        kind: "agentAllow",
        id: record.install.agentId,
        action: "remove",
        target: `tools.agentToAgent.allow[${record.install.agentId}]`,
        blocked: record.agentState === "modified",
        details: { count: effects.pruned.removedAllow },
      });
    }
    if (effects.workspace) {
      actions.push({
        kind: "workspace",
        id: record.install.agentId,
        action: effects.workspaceRetained ? "retain" : "trash",
        target: effects.workspace,
        blocked: record.agentState === "modified",
        details: {
          retained: effects.workspaceRetained,
          sharedWith: effects.workspaceSharedWith,
        },
        ...(effects.workspaceRetained ? { reason: "Workspace overlaps another agent." } : {}),
      });
    }
    if (effects.agentDir) {
      actions.push({
        kind: "agentState",
        id: record.install.agentId,
        action: "trash",
        target: effects.agentDir,
        blocked: record.agentState === "modified",
      });
    }
    actions.push({
      kind: "sessionTranscripts",
      id: record.install.agentId,
      action: "trash",
      target: effects.sessionsDir,
      blocked: record.agentState === "modified",
    });
    for (const file of record.workspaceFiles) {
      actions.push({
        kind: "workspaceFile",
        id: file.path,
        action: file.state === "unchanged" ? "delete" : "retain",
        target: `${file.workspace}:${file.path}`,
        blocked: file.state === "unsafe",
        details: {
          expectedState: file.state,
          contentDigest: file.contentDigest,
          workspace: file.workspace,
        },
        ...(file.state === "modified"
          ? { reason: "Local content changed; preserve the file." }
          : {}),
      });
    }
    for (const decision of packageDecisions) {
      const pkg = decision.packageRef;
      const inspected = record.packages.find(
        (candidate) =>
          candidate.kind === pkg.kind &&
          candidate.source === pkg.source &&
          candidate.ref === pkg.ref &&
          candidate.version === pkg.version,
      );
      actions.push({
        kind: "packageRef",
        id: `${pkg.kind}:${pkg.ref}@${pkg.version}`,
        action: decision.action === "uninstall" ? "uninstall" : "release",
        target: `${pkg.source}:${pkg.ref}@${pkg.version}`,
        blocked: false,
        details: {
          expectedState: inspected?.state ?? "incomplete",
          status: pkg.status,
          ownership: pkg.ownership,
        },
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
    }
    actions.push({
      kind: "installRecord",
      id: record.install.agentId,
      action: "remove",
      target: `claw_installs:${record.install.agentId}`,
      blocked: false,
      details: {
        expectedStatus: record.install.status,
        planIntegrity: record.install.planIntegrity,
        sourceIntegrity: record.install.claw.integrity,
      },
    });
  }
  const planIdentity = {
    target,
    agentId: record?.install.agentId,
    actions,
    blockers,
  };
  return {
    schemaVersion: CLAW_REMOVE_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: `sha256:${createHash("sha256")
      .update(stableStringify(planIdentity))
      .digest("hex")}`,
    target,
    ...(record ? { agentId: record.install.agentId } : {}),
    actions,
    blockers,
  };
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db /* sqlite-allow-raw: schema probe for optional Claw state tables. */
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );
}

async function removeFile(record: ClawManagedFileStatus): Promise<RemovedWorkspaceFile> {
  if (record.state === "missing") {
    return { path: record.path, action: "missing" };
  }
  if (record.state === "modified") {
    return { path: record.path, action: "retainedModified" };
  }
  try {
    const workspace = await fsSafeRoot(record.workspace, {
      hardlinks: "reject",
      maxBytes: MAX_FILE_BYTES,
      symlinks: "reject",
    });
    if (!(await workspace.exists(record.path))) {
      return { path: record.path, action: "missing" };
    }
    const stagedPath = `${record.path}.openclaw-claw-remove-${randomUUID()}`;
    await workspace.move(record.path, stagedPath, { overwrite: false });
    const content = await workspace.readBytes(stagedPath, { maxBytes: MAX_FILE_BYTES });
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (digest !== record.contentDigest) {
      await workspace.move(stagedPath, record.path, { overwrite: false });
      return { path: record.path, action: "retainedModified" };
    }
    await workspace.remove(stagedPath);
    return { path: record.path, action: "deleted" };
  } catch (error) {
    return {
      path: record.path,
      action: "error",
      message: error instanceof FsSafeError ? `${error.code}: ${error.message}` : String(error),
    };
  }
}
function releaseRows(
  agentId: string,
  files: RemovedWorkspaceFile[],
  complete: boolean,
  options: OpenClawStateDatabaseOptions,
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    if (tableExists(db, "claw_workspace_files")) {
      for (const file of files.filter((candidate) => candidate.action !== "error")) {
        db /* sqlite-allow-raw: remove one owned Claw workspace-file row. */
          .prepare("DELETE FROM claw_workspace_files WHERE agent_id = ? AND target_path = ?")
          .run(agentId, file.path);
      }
    }
    if (!complete) {
      return;
    }
    if (tableExists(db, "claw_package_refs")) {
      db /* sqlite-allow-raw: release package refs for a removed Claw agent. */
        .prepare("DELETE FROM claw_package_refs WHERE agent_id = ?")
        .run(agentId);
    }
    if (tableExists(db, "claw_installs")) {
      db /* sqlite-allow-raw: remove the completed Claw install owner row. */
        .prepare("DELETE FROM claw_installs WHERE agent_id = ?")
        .run(agentId);
    }
  }, options);
}

type ConfigCommit = (transform: (config: OpenClawConfig) => OpenClawConfig) => Promise<void>;
export async function applyClawRemovePlan(
  plan: ClawRemovePlan,
  options: OpenClawStateDatabaseOptions & {
    config?: OpenClawConfig;
    commitConfig?: ConfigCommit;
    packageDeps?: PackageRemovalDeps;
    consentPlanIntegrity?: string;
  } = {},
): Promise<ClawRemoveResult> {
  if (options.consentPlanIntegrity !== plan.planIntegrity) {
    throw new ClawRemoveError(
      "plan_integrity_mismatch",
      "Consent does not match the current Claw remove plan; run remove --dry-run again.",
    );
  }
  if (plan.blockers.length > 0 || !plan.agentId) {
    throw new ClawRemoveError("remove_blocked", "The Claw remove plan contains blockers.");
  }
  const currentPlan = await buildClawRemovePlan(plan.target, options);
  if (currentPlan.planIntegrity !== plan.planIntegrity) {
    throw new ClawRemoveError("remove_changed", "Claw-owned state changed after remove planning.");
  }
  const agentId = plan.agentId;
  const current = await readClawStatus(plan.agentId, options);
  const record = current.records[0];
  if (
    !record ||
    record.agentState === "modified" ||
    record.workspaceFiles.some((file) => file.state === "unsafe")
  ) {
    throw new ClawRemoveError("remove_changed", "Claw-owned state changed after remove planning.");
  }
  const packageDecisions = await planClawPackageRemovals(record.install, record.packages, {
    ...options,
    deps: options.packageDeps,
  });
  const plannedPackages = plan.actions
    .filter((action) => action.kind === "packageRef")
    .map((action) => `${action.id}:${action.action}`)
    .toSorted();
  const currentPackages = packageDecisions
    .map(
      (decision) =>
        `${decision.packageRef.kind}:${decision.packageRef.ref}@${decision.packageRef.version}:${decision.action === "uninstall" ? "uninstall" : "release"}`,
    )
    .toSorted();
  if (JSON.stringify(plannedPackages) !== JSON.stringify(currentPackages)) {
    throw new ClawRemoveError("remove_changed", "Package ownership changed after remove planning.");
  }
  let agentRemoved = false;
  const packages = await applyClawPackageRemovals(packageDecisions, {
    ...options,
    deps: options.packageDeps,
  });
  const packageErrors = packages.filter((pkg) => pkg.action === "error");
  if (packageErrors.length > 0) {
    updateClawInstallRecordStatus(agentId, "partial", options);
    return {
      schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      dryRun: false,
      status: "partial",
      agentId: plan.agentId,
      agentRemoved,
      workspaceFiles: [],
      packages,
      packageRefsReleased: 0,
      error: {
        code: "package_cleanup_failed",
        message: packageErrors.map((pkg) => pkg.reason).join("; "),
      },
    };
  }
  let committedDelete: Awaited<ReturnType<typeof deleteAgentConfigEntry>>["result"] | undefined;
  let committedNextConfig: OpenClawConfig | undefined;
  if (options.commitConfig) {
    await options.commitConfig((config) => {
      const deleteEffects = deletionEffects(config, agentId);
      const agents = config.agents?.list ?? [];
      const agent = agents.find((candidate) => candidate.id === plan.agentId);
      if (agent && digestAgent(agent) !== record.install.agentConfigDigest) {
        throw new ClawRemoveError("agent_modified", "Agent config changed during remove.");
      }
      agentRemoved = Boolean(agent);
      return deleteEffects.pruned.config;
    });
  } else {
    const committed = await deleteAgentConfigEntry({
      agentId,
      validate: (agent) => {
        if (digestAgent(agent) !== record.install.agentConfigDigest) {
          throw new ClawRemoveError("agent_modified", "Agent config changed during remove.");
        }
      },
    });
    agentRemoved = Boolean(committed.result);
    committedDelete = committed.result;
    committedNextConfig = committed.nextConfig;
  }
  const workspaceFiles: RemovedWorkspaceFile[] = [];
  for (const file of record.workspaceFiles) {
    workspaceFiles.push(await removeFile(file));
  }
  const errors = workspaceFiles.filter((file) => file.action === "error");
  const complete = errors.length === 0;
  if (complete && committedDelete && committedNextConfig) {
    const workspaceSharedWith = findOverlappingWorkspaceAgentIds(
      committedNextConfig,
      agentId,
      committedDelete.workspaceDir,
    );
    if (workspaceSharedWith.length === 0) {
      const legacyPlan = prepareLegacyWorkspaceStateReset(committedDelete.workspaceDir);
      const statePlan = prepareWorkspaceStateDeletion(committedDelete.workspaceDir);
      const workspaceRemoved = await moveToTrash(
        committedDelete.workspaceDir,
        clawRemoveQuietRuntime,
      );
      if (workspaceRemoved) {
        const legacyCleanup = await removeLegacyWorkspaceStateForReset(legacyPlan);
        for (const warning of legacyCleanup.warnings) {
          clawRemoveQuietRuntime.log(warning);
        }
        deleteWorkspaceState(statePlan);
      }
    }
    await moveToTrash(committedDelete.agentDir, clawRemoveQuietRuntime);
    await moveToTrash(committedDelete.sessionsDir, clawRemoveQuietRuntime);
  }
  releaseRows(plan.agentId, workspaceFiles, complete, options);
  return {
    schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: false,
    status: complete ? "complete" : "partial",
    agentId: plan.agentId,
    agentRemoved,
    workspaceFiles,
    packages,
    packageRefsReleased: complete ? record.packages.length : 0,
    ...(complete
      ? {}
      : {
          error: {
            code: "workspace_cleanup_failed",
            message: errors.map((error) => error.message).join("; "),
          },
        }),
  };
}
