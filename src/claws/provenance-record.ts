import { encodeClawAgentOwnership } from "./provenance-agent-origin.js";
import type { PersistedClawInstall } from "./provenance-types.js";
import type { ClawAddPlan } from "./types.js";

export function clawAgentOwnedPaths(plan: ClawAddPlan): string[] {
  return plan.actions.filter((action) => action.kind === "agent").map((action) => action.target);
}

export function prepareClawInstallRecord(
  plan: ClawAddPlan,
  fields: Pick<
    PersistedClawInstall,
    "agentOrigin" | "agentConfigDigest" | "status" | "addedAtMs" | "updatedAtMs" | "bootstrap"
  >,
) {
  const agentOwnedPaths = clawAgentOwnedPaths(plan);
  const ownership = encodeClawAgentOwnership(agentOwnedPaths, fields.agentOrigin);
  const record: PersistedClawInstall = {
    schemaVersion: ownership.schemaVersion,
    claw: plan.claw,
    manifestSchemaVersion: plan.manifestSchemaVersion,
    planIntegrity: plan.planIntegrity,
    agentId: plan.agent.finalId,
    workspace: plan.agent.workspace,
    agentConfigDigest: fields.agentConfigDigest,
    agentOrigin: fields.agentOrigin,
    agentOwnedPaths,
    ...(fields.bootstrap ? { bootstrap: fields.bootstrap } : {}),
    status: fields.status,
    addedAtMs: fields.addedAtMs,
    updatedAtMs: fields.updatedAtMs,
  };
  return {
    record,
    sqlFields: {
      schema_version: record.schemaVersion,
      source_kind: record.claw.kind,
      claw_name: record.claw.name,
      claw_version: record.claw.version,
      package_root: record.claw.packageRoot,
      manifest_path: record.claw.manifestPath,
      integrity_kind: record.claw.integrityKind,
      integrity: record.claw.integrity,
      source_byte_length: record.claw.byteLength,
      manifest_schema_version: record.manifestSchemaVersion,
      plan_integrity: record.planIntegrity,
      workspace: record.workspace,
      agent_config_digest: record.agentConfigDigest,
      agent_owned_paths_json: ownership.agentOwnedPathsJson,
      bootstrap_source_path: record.bootstrap?.sourcePath ?? null,
      bootstrap_content_digest: record.bootstrap?.contentDigest ?? null,
      status: record.status,
      updated_at_ms: record.updatedAtMs,
    },
  };
}
