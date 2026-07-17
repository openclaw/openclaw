import { createHash } from "node:crypto";
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
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import { listConfiguredMcpServers, unsetConfiguredMcpServer } from "../config/mcp-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { deleteAgentConfigEntry } from "../gateway/server-methods/agents-config-mutations.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  deleteClawCronRef,
  markClawCronRefRemoved,
  readClawCronRefs,
  type ClawCronGateway,
  type PersistedClawCronRef,
} from "./cron.js";
import {
  clawRemoveQuietRuntime,
  deletionEffects,
  readAllClawWorkspaceFiles,
  releaseClawRemoveRows,
  removeClawWorkspaceFile,
  synthesizeOrphanInstall,
  type RemovedWorkspaceFile,
} from "./lifecycle-delete-support.js";
import {
  deleteClawMcpServerRef,
  digestClawMcpServer,
  planClawMcpServerRemoval,
  reconcileClawMcpServerRefs,
  type PersistedClawMcpServerRef,
} from "./mcp.js";
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
type ClawMcpServerStatus = PersistedClawMcpServerRef & {
  state: "present" | "modified" | "missing" | "pending" | "failed";
};
type ClawStatusRecord = {
  install: PersistedClawInstall;
  orphaned?: boolean;
  agentState: "present" | "modified" | "missing";
  workspaceFiles: ClawManagedFileStatus[];
  packages: ClawPackageInspection[];
  mcpServers: ClawMcpServerStatus[];
  cronJobs: PersistedClawCronRef[];
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
    mcpServerRefs: number;
    driftedMcpServers: number;
    unresolvedMcpServerRefs: number;
    cronRefs: number;
    unresolvedCronRefs: number;
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
    | "mcpServer"
    | "cronJob"
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
type RemovedCronJob = {
  manifestId: string;
  schedulerJobId?: string;
  action: "removed" | "error";
  message?: string;
};
type RemovedMcpServer = {
  name: string;
  action: "removed" | "missing" | "released" | "error";
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
  mcpServers: RemovedMcpServer[];
  cronJobs: RemovedCronJob[];
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

function inspectMcpServer(
  ref: PersistedClawMcpServerRef,
  configuredServers: Record<string, Record<string, unknown>>,
): ClawMcpServerStatus {
  if (ref.status === "pending" || ref.status === "failed") {
    return { ...ref, state: ref.status };
  }
  const server = configuredServers[ref.name];
  if (!server) {
    return { ...ref, state: "missing" };
  }
  return {
    ...ref,
    state: digestClawMcpServer(server) === ref.configDigest ? "present" : "modified",
  };
}

export async function readClawStatus(
  target?: string,
  options: OpenClawStateDatabaseOptions & {
    config?: OpenClawConfig;
    sourceMcpServers?: Record<string, Record<string, unknown>>;
    listMcpServers?: typeof listConfiguredMcpServers;
    packageDeps?: PackageRemovalDeps;
  } = {},
): Promise<ClawStatusResult> {
  const config = options.config ?? getRuntimeConfig();
  const listedMcp = options.sourceMcpServers
    ? undefined
    : options.listMcpServers
      ? await options.listMcpServers()
      : options.config
        ? undefined
        : await listConfiguredMcpServers();
  if (listedMcp && !listedMcp.ok) {
    throw new ClawRemoveError("mcp_config_unavailable", listedMcp.error);
  }
  const sourceConfig = listedMcp?.ok ? listedMcp.config : config;
  const configuredMcpServers = normalizeConfiguredMcpServers(
    options.sourceMcpServers ?? sourceConfig.mcp?.servers,
  );
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
      mcpServers: reconcileClawMcpServerRefs(install.agentId, configuredMcpServers, options).map(
        (ref) => inspectMcpServer(ref, configuredMcpServers),
      ),
      cronJobs: readClawCronRefs(install.agentId, options),
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
      mcpServerRefs: records.flatMap((record) => record.mcpServers).length,
      driftedMcpServers: records
        .flatMap((record) => record.mcpServers)
        .filter((server) => server.state === "modified" || server.state === "missing").length,
      unresolvedMcpServerRefs: records
        .flatMap((record) => record.mcpServers)
        .filter((server) => server.state === "pending" || server.state === "failed").length,
      cronRefs: records.flatMap((record) => record.cronJobs).length,
      unresolvedCronRefs: records
        .flatMap((record) => record.cronJobs)
        .filter((cron) => cron.status !== "complete" || !cron.schedulerJobId).length,
    },
  };
}

export async function buildClawRemovePlan(
  target: string,
  options: OpenClawStateDatabaseOptions & {
    config?: OpenClawConfig;
    sourceMcpServers?: Record<string, Record<string, unknown>>;
    listMcpServers?: typeof listConfiguredMcpServers;
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
  for (const server of record?.mcpServers ?? []) {
    if (server.state === "pending") {
      blockers.push({
        code: "mcp_cleanup_uncertain",
        message: `MCP server ${JSON.stringify(server.name)} has ${server.state} ownership state and must be reconciled before removal.`,
      });
    }
  }
  for (const cron of record?.cronJobs ?? []) {
    if (cron.status !== "removed" && (cron.status !== "complete" || !cron.schedulerJobId)) {
      blockers.push({
        code: "cron_cleanup_uncertain",
        message: `Cron declaration ${JSON.stringify(cron.manifestId)} has ${cron.status} ownership state and must be reconciled before removal.`,
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
    for (const server of record.mcpServers) {
      const blocked = server.state === "pending";
      const ownerAction =
        server.state === "present" ? planClawMcpServerRemoval(server, options) : "release";
      actions.push({
        kind: "mcpServer",
        id: server.name,
        action: blocked ? "retain" : ownerAction,
        target: `mcp.servers.${server.name}`,
        blocked,
        details: {
          expectedState: server.state,
          configDigest: server.configDigest,
          ownership: server.ownership,
        },
        ...(blocked ? { reason: `MCP ownership state is ${server.state}.` } : {}),
      });
    }
    for (const cron of record.cronJobs) {
      const blocked =
        cron.status !== "removed" && (cron.status !== "complete" || !cron.schedulerJobId);
      actions.push({
        kind: "cronJob",
        id: cron.manifestId,
        action: blocked ? "retain" : "remove",
        target: cron.schedulerJobId ?? cron.declarationKey,
        blocked,
        details: {
          expectedStatus: cron.status,
          declarationKey: cron.declarationKey,
          schedulerJobId: cron.schedulerJobId,
          job: cron.job,
        },
        ...(blocked ? { reason: `Cron ownership state is ${cron.status}.` } : {}),
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

type ConfigCommit = (transform: (config: OpenClawConfig) => OpenClawConfig) => Promise<void>;
export async function applyClawRemovePlan(
  plan: ClawRemovePlan,
  options: OpenClawStateDatabaseOptions & {
    config?: OpenClawConfig;
    sourceMcpServers?: Record<string, Record<string, unknown>>;
    listMcpServers?: typeof listConfiguredMcpServers;
    commitConfig?: ConfigCommit;
    deleteAgent?: (agentId: string) => Promise<void>;
    packageDeps?: PackageRemovalDeps;
    consentPlanIntegrity?: string;
    unsetMcpServer?: typeof unsetConfiguredMcpServer;
    cronGateway?: Pick<ClawCronGateway, "remove">;
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
    record.workspaceFiles.some((file) => file.state === "unsafe") ||
    record.mcpServers.some((server) => server.state === "pending")
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
  const plannedMcpServers = plan.actions
    .filter((action) => action.kind === "mcpServer")
    .map((action) => `${action.id}:${action.action}`)
    .toSorted();
  const currentMcpServers = record.mcpServers
    .map((server) => {
      const action =
        server.state === "present" ? planClawMcpServerRemoval(server, options) : "release";
      return `${server.name}:${action}`;
    })
    .toSorted();
  if (JSON.stringify(plannedMcpServers) !== JSON.stringify(currentMcpServers)) {
    throw new ClawRemoveError("remove_changed", "MCP ownership changed after remove planning.");
  }
  const mcpServers: RemovedMcpServer[] = [];
  const listedMcpServers = options.sourceMcpServers
    ? undefined
    : options.listMcpServers
      ? await options.listMcpServers()
      : options.config
        ? undefined
        : await listConfiguredMcpServers();
  if (listedMcpServers && !listedMcpServers.ok) {
    throw new ClawRemoveError("mcp_config_unavailable", listedMcpServers.error);
  }
  const configuredMcpServers = listedMcpServers?.ok
    ? listedMcpServers.mcpServers
    : normalizeConfiguredMcpServers(options.sourceMcpServers ?? options.config?.mcp?.servers);
  const unsetMcpServer = options.unsetMcpServer ?? unsetConfiguredMcpServer;
  for (const server of record.mcpServers) {
    const ownerAction =
      server.state === "present" ? planClawMcpServerRemoval(server, options) : "release";
    if (server.state !== "present" || ownerAction === "release") {
      deleteClawMcpServerRef(plan.agentId, server.name, options);
      mcpServers.push({
        name: server.name,
        action: server.state === "missing" ? "missing" : "released",
      });
      continue;
    }
    const expectedServer = configuredMcpServers[server.name];
    if (!expectedServer) {
      throw new ClawRemoveError(
        "mcp_cleanup_changed",
        `MCP server ${JSON.stringify(server.name)} disappeared during removal.`,
      );
    }
    try {
      const result = await unsetMcpServer({ name: server.name, expectedServer });
      if (!result.ok) {
        throw new Error(result.error);
      }
      deleteClawMcpServerRef(plan.agentId, server.name, options);
      mcpServers.push({ name: server.name, action: result.removed ? "removed" : "missing" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mcpServers.push({ name: server.name, action: "error", message });
      updateClawInstallRecordStatus(agentId, "partial", options);
      return {
        schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        dryRun: false,
        status: "partial",
        agentId,
        agentRemoved: false,
        workspaceFiles: [],
        packages: [],
        mcpServers,
        cronJobs: [],
        packageRefsReleased: 0,
        error: { code: "mcp_cleanup_failed", message },
      };
    }
  }
  const cronJobs: RemovedCronJob[] = [];
  for (const cron of record.cronJobs) {
    if (cron.status !== "removed" && (!cron.schedulerJobId || cron.status !== "complete")) {
      throw new ClawRemoveError(
        "cron_cleanup_uncertain",
        `Cron declaration ${JSON.stringify(cron.manifestId)} is not safely removable.`,
      );
    }
    if (cron.status !== "removed" && !options.cronGateway) {
      throw new ClawRemoveError(
        "cron_gateway_required",
        "Claw cron jobs require the gateway-owned cron.remove API.",
      );
    }
    try {
      if (cron.status !== "removed") {
        await options.cronGateway!.remove(cron.schedulerJobId!);
        markClawCronRefRemoved(plan.agentId, cron.manifestId, options);
      }
      deleteClawCronRef(plan.agentId, cron.manifestId, options);
      cronJobs.push({
        manifestId: cron.manifestId,
        schedulerJobId: cron.schedulerJobId,
        action: "removed",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cronJobs.push({
        manifestId: cron.manifestId,
        schedulerJobId: cron.schedulerJobId,
        action: "error",
        message,
      });
      updateClawInstallRecordStatus(agentId, "partial", options);
      return {
        schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        dryRun: false,
        status: "partial",
        agentId: plan.agentId,
        agentRemoved: false,
        workspaceFiles: [],
        packages: [],
        mcpServers,
        cronJobs,
        packageRefsReleased: 0,
        error: { code: "cron_cleanup_failed", message },
      };
    }
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
      mcpServers,
      cronJobs,
      packageRefsReleased: 0,
      error: {
        code: "package_cleanup_failed",
        message: packageErrors.map((pkg) => pkg.reason).join("; "),
      },
    };
  }
  let committedDelete: Awaited<ReturnType<typeof deleteAgentConfigEntry>>["result"] | undefined;
  let committedNextConfig: OpenClawConfig | undefined;
  if (record.agentState === "present" && options.deleteAgent) {
    try {
      await options.deleteAgent(agentId);
      agentRemoved = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateClawInstallRecordStatus(agentId, "partial", options);
      return {
        schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        dryRun: false,
        status: "partial",
        agentId,
        agentRemoved: false,
        workspaceFiles: [],
        packages,
        mcpServers,
        cronJobs,
        packageRefsReleased: 0,
        error: { code: "agent_cleanup_failed", message },
      };
    }
  } else if (options.commitConfig) {
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
    workspaceFiles.push(await removeClawWorkspaceFile(file));
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
  releaseClawRemoveRows(plan.agentId, workspaceFiles, complete, options);
  return {
    schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: false,
    status: complete ? "complete" : "partial",
    agentId: plan.agentId,
    agentRemoved,
    workspaceFiles,
    packages,
    mcpServers,
    cronJobs,
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

/* oxlint-disable max-lines -- Stacked Claw lifecycle/remove composition keeps status, plan, and apply together until the RFC surface settles. */
