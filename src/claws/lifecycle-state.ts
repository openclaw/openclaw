import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { stableStringify } from "../agents/stable-stringify.js";
import { pruneAgentConfig } from "../commands/agents.config.js";
import { loadConfig, transformConfigFileWithRetry } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { root as fsSafeRoot, FsSafeError } from "../infra/fs-safe.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  readClawInstallRecords,
  readClawPackageRefs,
  type PersistedClawInstall,
  type PersistedClawPackageRef,
} from "./provenance.js";
import { CLAW_OUTPUT_STABILITY } from "./types.js";
import { readClawWorkspaceFiles, type PersistedClawWorkspaceFile } from "./workspace.js";

export const CLAW_STATUS_SCHEMA_VERSION = "openclaw.clawStatus.v1" as const;
export const CLAW_REMOVE_PLAN_SCHEMA_VERSION = "openclaw.clawRemovePlan.v1" as const;
export const CLAW_REMOVE_RESULT_SCHEMA_VERSION = "openclaw.clawRemoveResult.v1" as const;
const MAX_FILE_BYTES = 1024 * 1024;

export type ClawManagedFileStatus = PersistedClawWorkspaceFile & {
  state: "unchanged" | "modified" | "missing" | "unsafe";
  message?: string;
};
export type ClawStatusRecord = {
  install: PersistedClawInstall;
  agentState: "present" | "modified" | "missing";
  workspaceFiles: ClawManagedFileStatus[];
  packages: PersistedClawPackageRef[];
};
export type ClawStatusResult = {
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
  };
};
export type ClawRemovePlanAction = {
  kind: "agent" | "workspaceFile" | "packageRef" | "installRecord";
  id: string;
  action: "remove" | "delete" | "retain" | "release";
  target: string;
  blocked: boolean;
  reason?: string;
};
export type ClawRemovePlan = {
  schemaVersion: typeof CLAW_REMOVE_PLAN_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: true;
  mutationAllowed: false;
  target: string;
  agentId?: string;
  actions: ClawRemovePlanAction[];
  blockers: Array<{ code: string; message: string }>;
};
export type RemovedWorkspaceFile = {
  path: string;
  action: "deleted" | "missing" | "retainedModified" | "error";
  message?: string;
};
export type ClawRemoveResult = {
  schemaVersion: typeof CLAW_REMOVE_RESULT_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: false;
  status: "complete" | "partial";
  agentId: string;
  agentRemoved: boolean;
  workspaceFiles: RemovedWorkspaceFile[];
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
  options: OpenClawStateDatabaseOptions & { config?: OpenClawConfig } = {},
): Promise<ClawStatusResult> {
  const config = options.config ?? loadConfig();
  const installs = readClawInstallRecords(options).filter(
    (install) => !target || install.agentId === target || install.claw.name === target,
  );
  const records: ClawStatusRecord[] = [];
  for (const install of installs) {
    const agent = config.agents?.list?.find((candidate) => candidate.id === install.agentId);
    records.push({
      install,
      agentState: !agent
        ? "missing"
        : digestAgent(agent) === install.agentConfigDigest
          ? "present"
          : "modified",
      workspaceFiles: await Promise.all(
        readClawWorkspaceFiles(install.agentId, options).map(inspectFile),
      ),
      packages: readClawPackageRefs({ ...options, agentId: install.agentId }),
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
    },
  };
}

export async function buildClawRemovePlan(
  target: string,
  options: OpenClawStateDatabaseOptions & { config?: OpenClawConfig } = {},
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
    actions.push({
      kind: "agent",
      id: record.install.agentId,
      action: "remove",
      target: `agents.list[${record.install.agentId}]`,
      blocked: record.agentState === "modified",
      ...(record.agentState === "modified" ? { reason: "Agent config digest changed." } : {}),
    });
    for (const file of record.workspaceFiles) {
      actions.push({
        kind: "workspaceFile",
        id: file.path,
        action: file.state === "unchanged" ? "delete" : "retain",
        target: `${file.workspace}:${file.path}`,
        blocked: file.state === "unsafe",
        ...(file.state === "modified"
          ? { reason: "Local content changed; preserve the file." }
          : {}),
      });
    }
    for (const pkg of record.packages) {
      actions.push({
        kind: "packageRef",
        id: `${pkg.kind}:${pkg.ref}@${pkg.version}`,
        action: "release",
        target: `${pkg.source}:${pkg.ref}@${pkg.version}`,
        blocked: false,
      });
    }
    actions.push({
      kind: "installRecord",
      id: record.install.agentId,
      action: "remove",
      target: `claw_installs:${record.install.agentId}`,
      blocked: false,
    });
  }
  return {
    schemaVersion: CLAW_REMOVE_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    target,
    ...(record ? { agentId: record.install.agentId } : {}),
    actions,
    blockers,
  };
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
    const content = await workspace.readBytes(record.path, { maxBytes: MAX_FILE_BYTES });
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (digest !== record.contentDigest) {
      return { path: record.path, action: "retainedModified" };
    }
    await workspace.remove(record.path);
    return { path: record.path, action: "deleted" };
  } catch (error) {
    return {
      path: record.path,
      action: "error",
      message: error instanceof FsSafeError ? `${error.code}: ${error.message}` : String(error),
    };
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
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
        db.prepare("DELETE FROM claw_workspace_files WHERE agent_id = ? AND target_path = ?").run(
          agentId,
          file.path,
        );
      }
    }
    if (!complete) {
      return;
    }
    if (tableExists(db, "claw_package_refs")) {
      db.prepare("DELETE FROM claw_package_refs WHERE agent_id = ?").run(agentId);
    }
    if (tableExists(db, "claw_installs")) {
      db.prepare("DELETE FROM claw_installs WHERE agent_id = ?").run(agentId);
    }
  }, options);
}

type ConfigCommit = (transform: (config: OpenClawConfig) => OpenClawConfig) => Promise<void>;
export async function applyClawRemovePlan(
  plan: ClawRemovePlan,
  options: OpenClawStateDatabaseOptions & {
    config?: OpenClawConfig;
    commitConfig?: ConfigCommit;
  } = {},
): Promise<ClawRemoveResult> {
  if (plan.blockers.length > 0 || !plan.agentId) {
    throw new ClawRemoveError("remove_blocked", "The Claw remove plan contains blockers.");
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
  const commit: ConfigCommit =
    options.commitConfig ??
    (async (transform) => {
      await transformConfigFileWithRetry({
        afterWrite: { mode: "auto" },
        transform: (config) => ({ nextConfig: transform(config) }),
      });
    });
  let agentRemoved = false;
  await commit((config) => {
    const agents = config.agents?.list ?? [];
    const agent = agents.find((candidate) => candidate.id === plan.agentId);
    if (agent && digestAgent(agent) !== record.install.agentConfigDigest) {
      throw new ClawRemoveError("agent_modified", "Agent config changed during remove.");
    }
    agentRemoved = Boolean(agent);
    return pruneAgentConfig(config, agentId).config;
  });
  const workspaceFiles: RemovedWorkspaceFile[] = [];
  for (const file of record.workspaceFiles) {
    workspaceFiles.push(await removeFile(file));
  }
  const errors = workspaceFiles.filter((file) => file.action === "error");
  const complete = errors.length === 0;
  releaseRows(plan.agentId, workspaceFiles, complete, options);
  return {
    schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: false,
    status: complete ? "complete" : "partial",
    agentId: plan.agentId,
    agentRemoved,
    workspaceFiles,
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
