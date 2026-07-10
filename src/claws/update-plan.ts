// Builds read-only, agent-centric Claw update plans from grouped manifests and ownership state.
import { createHash } from "node:crypto";
import { stableStringify } from "../agents/stable-stringify.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { readClawStatus } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { digestClawMcpServer } from "./mcp.js";
import {
  CLAW_OUTPUT_STABILITY,
  type ClawDiagnostic,
  type ClawManifest,
  type ClawSourceIdentity,
} from "./types.js";

export const CLAW_UPDATE_PLAN_SCHEMA_VERSION = "openclaw.clawUpdatePlan.v1" as const;

export type ClawUpdateAction = {
  kind: "agent" | "workspaceFile" | "package" | "mcpServer" | "cronJob";
  id: string;
  action: "add" | "change" | "remove" | "unchanged" | "manual";
  target: string;
  blocked: boolean;
  reason: string;
  currentDigest?: string;
  desiredDigest?: string;
};

export type ClawUpdatePlan = {
  schemaVersion: typeof CLAW_UPDATE_PLAN_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: true;
  mutationAllowed: false;
  found: boolean;
  agentId: string;
  currentClaw?: { name: string; version: string; integrity: string };
  targetClaw?: { name: string; version: string; integrity: string };
  summary: {
    totalActions: number;
    added: number;
    changed: number;
    removed: number;
    unchanged: number;
    manual: number;
    blocked: number;
  };
  actions: ClawUpdateAction[];
  blockers: ClawDiagnostic[];
  diagnostics: ClawDiagnostic[];
};

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function diagnostic(code: string, path: string, message: string): ClawDiagnostic {
  return { level: "error", code, path, message };
}

function summarize(actions: ClawUpdateAction[]): ClawUpdatePlan["summary"] {
  return {
    totalActions: actions.length,
    added: actions.filter((action) => action.action === "add").length,
    changed: actions.filter((action) => action.action === "change").length,
    removed: actions.filter((action) => action.action === "remove").length,
    unchanged: actions.filter((action) => action.action === "unchanged").length,
    manual: actions.filter((action) => action.action === "manual").length,
    blocked: actions.filter((action) => action.blocked).length,
  };
}

function emptyPlan(params: {
  agentId: string;
  source?: ClawSourceIdentity;
  found?: boolean;
  blockers: ClawDiagnostic[];
  diagnostics?: ClawDiagnostic[];
}): ClawUpdatePlan {
  return {
    schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    found: params.found ?? false,
    agentId: params.agentId,
    ...(params.source
      ? {
          targetClaw: {
            name: params.source.name,
            version: params.source.version,
            integrity: params.source.integrity,
          },
        }
      : {}),
    summary: summarize([]),
    actions: [],
    blockers: params.blockers,
    diagnostics: params.diagnostics ?? [],
  };
}

function manualState(state: string): boolean {
  return state === "modified" || state === "unsafe" || state === "pending" || state === "failed";
}

export async function buildClawUpdatePlan(params: {
  agentId: string;
  targetManifest: ClawManifest;
  targetSource: ClawSourceIdentity;
  config: OpenClawConfig;
  stateOptions?: OpenClawStateDatabaseOptions;
  diagnostics?: ClawDiagnostic[];
}): Promise<ClawUpdatePlan> {
  const status = await readClawStatus(params.agentId, {
    ...params.stateOptions,
    config: params.config,
  });
  if (status.records.length === 0) {
    return emptyPlan({
      agentId: params.agentId,
      source: params.targetSource,
      blockers: [
        diagnostic(
          "claw_not_found",
          "$",
          `No installed Claw agent matches ${JSON.stringify(params.agentId)}.`,
        ),
      ],
      diagnostics: params.diagnostics,
    });
  }
  if (status.records.length > 1) {
    return emptyPlan({
      agentId: params.agentId,
      source: params.targetSource,
      found: true,
      blockers: [
        diagnostic(
          "claw_ambiguous",
          "$",
          `Claw name ${JSON.stringify(params.agentId)} matches multiple agents; use an agent id.`,
        ),
      ],
      diagnostics: params.diagnostics,
    });
  }
  const record = status.records[0]!;
  const agentId = record.install.agentId;
  if (record.install.claw.name !== params.targetSource.name) {
    return {
      ...emptyPlan({
        agentId,
        source: params.targetSource,
        found: true,
        blockers: [
          diagnostic(
            "claw_identity_mismatch",
            "$.name",
            `Target package ${JSON.stringify(params.targetSource.name)} does not match installed Claw ${JSON.stringify(record.install.claw.name)}.`,
          ),
        ],
        diagnostics: params.diagnostics,
      }),
      currentClaw: {
        name: record.install.claw.name,
        version: record.install.claw.version,
        integrity: record.install.claw.integrity,
      },
    };
  }

  const targetPlan = await buildClawAddPlan({
    manifest: params.targetManifest,
    source: params.targetSource,
    diagnostics: params.diagnostics,
    context: { agentId, workspace: record.install.workspace },
  });
  const blockers = targetPlan.blockers.filter(
    (entry) => entry.code !== "workspace_collision" && entry.code !== "agent_id_collision",
  );
  const actions: ClawUpdateAction[] = [];

  const desiredAgentDigest = digest(targetPlan.agent.config);
  const agentAction =
    record.agentState === "modified"
      ? "manual"
      : record.agentState === "missing"
        ? "change"
        : record.install.agentConfigDigest === desiredAgentDigest
          ? "unchanged"
          : "change";
  actions.push({
    kind: "agent",
    id: agentId,
    action: agentAction,
    target: `agents.list.${agentId}`,
    blocked: agentAction === "manual",
    reason:
      agentAction === "manual"
        ? "Live agent config changed after installation and must be reconciled manually."
        : record.agentState === "missing"
          ? "Owned agent config is missing and would be restored from the target manifest."
          : agentAction === "unchanged"
            ? "Owned agent config already matches the target manifest."
            : "Target manifest changes owned agent config.",
    currentDigest: record.install.agentConfigDigest,
    desiredDigest: desiredAgentDigest,
  });

  const targetFiles = new Map(
    targetPlan.actions
      .filter((action) => action.kind === "workspaceFile")
      .map((action) => [action.id, action] as const),
  );
  const currentFiles = new Map(record.workspaceFiles.map((file) => [file.path, file] as const));
  for (const [path, target] of targetFiles) {
    const current = currentFiles.get(path);
    if (!target.digest) {
      actions.push({
        kind: "workspaceFile",
        id: path,
        action: "manual",
        target: `${record.install.workspace}:${path}`,
        blocked: true,
        reason: target.reason ?? "Target workspace source could not be verified.",
      });
      continue;
    }
    const action = !current
      ? "add"
      : manualState(current.state)
        ? "manual"
        : current.contentDigest === target.digest && current.state === "unchanged"
          ? "unchanged"
          : "change";
    actions.push({
      kind: "workspaceFile",
      id: path,
      action,
      target: `${record.install.workspace}:${path}`,
      blocked: action === "manual",
      reason:
        action === "add"
          ? "Target manifest adds a managed workspace file."
          : action === "manual"
            ? "Local workspace content changed or became unsafe and must be reconciled manually."
            : action === "unchanged"
              ? "Managed workspace content already matches the target source."
              : "Target source changes or restores managed workspace content.",
      ...(current ? { currentDigest: current.contentDigest } : {}),
      desiredDigest: target.digest,
    });
  }
  for (const current of record.workspaceFiles) {
    if (targetFiles.has(current.path)) {
      continue;
    }
    const manual = manualState(current.state);
    actions.push({
      kind: "workspaceFile",
      id: current.path,
      action: manual ? "manual" : "remove",
      target: `${current.workspace}:${current.path}`,
      blocked: manual,
      reason: manual
        ? "Target removes this file, but local drift must be preserved manually."
        : "Target manifest removes this managed workspace file.",
      currentDigest: current.contentDigest,
    });
  }

  const packageKey = (value: { kind: string; ref: string }) => `${value.kind}:${value.ref}`;
  const currentPackages = new Map(record.packages.map((pkg) => [packageKey(pkg), pkg] as const));
  const targetPackages = new Map(
    params.targetManifest.packages.map((pkg) => [packageKey(pkg), pkg] as const),
  );
  for (const [key, target] of targetPackages) {
    const current = currentPackages.get(key);
    const action = !current ? "add" : current.version === target.version ? "unchanged" : "change";
    actions.push({
      kind: "package",
      id: key,
      action,
      target: `${target.source}:${target.ref}@${target.version}`,
      blocked: false,
      reason:
        action === "add"
          ? "Target manifest adds a package reference."
          : action === "unchanged"
            ? "Recorded package reference already matches the exact target version."
            : "Target manifest changes the exact package version.",
      ...(current ? { currentDigest: digest(current) } : {}),
      desiredDigest: digest(target),
    });
  }
  for (const [key, current] of currentPackages) {
    if (!targetPackages.has(key)) {
      actions.push({
        kind: "package",
        id: key,
        action: "remove",
        target: `${current.source}:${current.ref}@${current.version}`,
        blocked: false,
        reason:
          "Target manifest removes this Claw package reference without implying shared uninstall.",
        currentDigest: digest(current),
      });
    }
  }

  const currentMcp = new Map(record.mcpServers.map((server) => [server.name, server] as const));
  for (const [name, target] of Object.entries(params.targetManifest.mcpServers)) {
    const current = currentMcp.get(name);
    const desiredDigest = digestClawMcpServer(target);
    const action = !current
      ? "add"
      : manualState(current.state)
        ? "manual"
        : current.configDigest === desiredDigest && current.state === "present"
          ? "unchanged"
          : "change";
    actions.push({
      kind: "mcpServer",
      id: name,
      action,
      target: `mcp.servers.${name}`,
      blocked: action === "manual",
      reason:
        action === "manual"
          ? "MCP ownership is unresolved or live config drifted and must be reconciled manually."
          : action === "unchanged"
            ? "Owned MCP config digest already matches the target declaration."
            : `Target manifest ${action === "add" ? "adds" : "changes or restores"} this MCP declaration.`,
      ...(current ? { currentDigest: current.configDigest } : {}),
      desiredDigest,
    });
  }
  for (const current of record.mcpServers) {
    if (Object.hasOwn(params.targetManifest.mcpServers, current.name)) {
      continue;
    }
    const manual = manualState(current.state);
    actions.push({
      kind: "mcpServer",
      id: current.name,
      action: manual ? "manual" : "remove",
      target: `mcp.servers.${current.name}`,
      blocked: manual,
      reason: manual
        ? "Target removes this MCP declaration, but ownership is unresolved or drifted."
        : "Target manifest removes this owned MCP declaration.",
      currentDigest: current.configDigest,
    });
  }

  const currentCron = new Map(record.cronJobs.map((cron) => [cron.manifestId, cron] as const));
  for (const target of params.targetManifest.cronJobs) {
    const current = currentCron.get(target.id);
    const desiredDigest = digest(target);
    const unresolved = current && (current.status !== "complete" || !current.schedulerJobId);
    const action = !current
      ? "add"
      : unresolved
        ? "manual"
        : digest(current.job) === desiredDigest
          ? "unchanged"
          : "change";
    actions.push({
      kind: "cronJob",
      id: target.id,
      action,
      target: current?.schedulerJobId ?? `claw:${agentId}:${target.id}`,
      blocked: action === "manual",
      reason:
        action === "manual"
          ? "Cron ownership is unresolved and must be reconciled with the gateway."
          : action === "unchanged"
            ? "Recorded cron declaration already matches the target manifest."
            : `Target manifest ${action === "add" ? "adds" : "changes"} this cron declaration.`,
      ...(current ? { currentDigest: digest(current.job) } : {}),
      desiredDigest,
    });
  }
  for (const current of record.cronJobs) {
    if (params.targetManifest.cronJobs.some((cron) => cron.id === current.manifestId)) {
      continue;
    }
    const manual = current.status !== "complete" || !current.schedulerJobId;
    actions.push({
      kind: "cronJob",
      id: current.manifestId,
      action: manual ? "manual" : "remove",
      target: current.schedulerJobId ?? current.declarationKey,
      blocked: manual,
      reason: manual
        ? "Target removes this cron declaration, but scheduler ownership is unresolved."
        : "Target manifest removes this owned cron declaration.",
      currentDigest: digest(current.job),
    });
  }

  actions.sort((left, right) =>
    `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`),
  );
  return {
    schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    found: true,
    agentId,
    currentClaw: {
      name: record.install.claw.name,
      version: record.install.claw.version,
      integrity: record.install.claw.integrity,
    },
    targetClaw: {
      name: params.targetSource.name,
      version: params.targetSource.version,
      integrity: params.targetSource.integrity,
    },
    summary: summarize(actions),
    actions,
    blockers,
    diagnostics: params.diagnostics ?? [],
  };
}
