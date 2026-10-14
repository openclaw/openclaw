import { withAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { digestClawValue } from "./digest.js";
import { ClawRemoveError } from "./lifecycle-delete-support.js";
import {
  CLAW_REMOVE_PLAN_SCHEMA_VERSION,
  CLAW_REMOVE_RESULT_SCHEMA_VERSION,
  type ClawRemoveApplyOptions,
  type ClawRemovePlan,
  type ClawRemovePlanAction,
  type ClawRemoveResult,
} from "./lifecycle-remove-contract.js";
import { readClawStatus, type ClawStatusRecord } from "./lifecycle-status.js";
import { releaseAdoptedClawInstallRecord } from "./provenance.js";
import { CLAW_OUTPUT_STABILITY } from "./types.js";

export function buildClawAdoptedRemovePlan(
  target: string,
  record: ClawStatusRecord,
  blockers: ClawRemovePlan["blockers"],
): ClawRemovePlan {
  const adoptedBlockers = [...blockers];
  if (record.install.status !== "complete") {
    adoptedBlockers.push({
      code: "adopted_install_incomplete",
      message: `Adopted Claw ownership is ${record.install.status}; reconcile it before removal.`,
    });
  }
  if (record.packages.length > 0 || record.mcpServers.length > 0 || record.cronJobs.length > 0) {
    adoptedBlockers.push({
      code: "adopted_managed_resources_present",
      message:
        "This adopted Claw has managed packages, MCP servers, or cron jobs. Removal will not touch the pre-existing agent; reconcile those Claw resources before releasing ownership.",
    });
  }
  const actions: ClawRemovePlanAction[] = [
    {
      kind: "agent",
      id: record.install.agentId,
      action: "retain",
      target: `agents.entries[${JSON.stringify(record.install.agentId)}]`,
      blocked: false,
      reason: "The agent existed before Claw migration and remains configured.",
    },
    {
      kind: "workspace",
      id: record.install.agentId,
      action: "retain",
      target: record.install.workspace,
      blocked: false,
      reason: "The workspace existed before Claw migration and remains in place.",
    },
    {
      kind: "agentState",
      id: record.install.agentId,
      action: "retain",
      target: "agent runtime state, credentials, and databases",
      blocked: false,
    },
    {
      kind: "sessionIndex",
      id: record.install.agentId,
      action: "retain",
      target: `session store entries for agent:${record.install.agentId}`,
      blocked: false,
    },
    {
      kind: "sessionTranscripts",
      id: record.install.agentId,
      action: "retain",
      target: "session transcripts",
      blocked: false,
    },
    ...record.workspaceFiles.map((file) => ({
      kind: "workspaceFile" as const,
      id: file.path,
      action: "retain" as const,
      target: file.path,
      blocked: false,
      reason: "The file predated migration; only its Claw ownership record is released.",
    })),
    {
      kind: "installRecord",
      id: record.install.agentId,
      action: "release",
      target: `claw_installs:${record.install.agentId}`,
      blocked: false,
      details: { expectedPlanIntegrity: record.install.planIntegrity },
    },
  ];
  const planIdentity = {
    target,
    agentId: record.install.agentId,
    actions,
    blockers: adoptedBlockers,
  };
  return {
    schemaVersion: CLAW_REMOVE_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: digestClawValue(planIdentity),
    target,
    agentId: record.install.agentId,
    actions,
    blockers: adoptedBlockers,
  };
}

export async function applyClawAdoptedRemovePlan(
  plan: ClawRemovePlan,
  options: ClawRemoveApplyOptions,
): Promise<ClawRemoveResult> {
  const agentId = plan.agentId;
  if (!agentId) {
    throw new ClawRemoveError("remove_blocked", "The adopted Claw remove plan has no agent id.");
  }
  return await withAgentDeletion(
    agentId,
    async () => {
      const lockedStatus = await readClawStatus(agentId, options);
      const record = lockedStatus.records[0];
      if (
        !record ||
        record.install.agentOrigin !== "adopted" ||
        record.install.status !== "complete" ||
        record.packages.length > 0 ||
        record.mcpServers.length > 0 ||
        record.cronJobs.length > 0
      ) {
        throw new ClawRemoveError(
          "remove_blocked",
          "Adopted Claw ownership now includes incomplete or managed secondary resources; review remove --dry-run and reconcile them first.",
        );
      }
      if (
        buildClawAdoptedRemovePlan(plan.target, record, []).planIntegrity !== plan.planIntegrity
      ) {
        throw new ClawRemoveError(
          "remove_changed",
          "Claw-owned state changed while waiting to release adopted ownership; review a fresh remove --dry-run plan.",
        );
      }
      releaseAdoptedClawInstallRecord(agentId, record.install.planIntegrity, options);
      return {
        schemaVersion: CLAW_REMOVE_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        dryRun: false,
        status: "complete",
        agentId,
        agentRemoved: false,
        workspaceFiles: [],
        packages: [],
        mcpServers: [],
        cronJobs: [],
        packageRefsReleased: 0,
        warnings: [
          "Released Claw ownership. The pre-existing agent, workspace, credentials, databases, sessions, transcripts, and generated local package were retained.",
        ],
      };
    },
    options,
  );
}
