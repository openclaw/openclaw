import { join } from "node:path";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { digestClawOwnedAgentConfig } from "./agent-config-ownership.js";
import { buildClawAddPlan } from "./lifecycle.js";
import type { PersistedClawInstall } from "./provenance-types.js";
import { parseClawManifest } from "./schema.js";
import type {
  ClawAddPlan,
  ClawOpenClawProfile,
  ClawSourceIdentity,
  ClawWorkspaceSourceSnapshot,
} from "./types.js";

export async function makeProvenancePlan(
  root: string,
  manifestValue: unknown,
  options: {
    workspace?: string;
    openClawProfile?: ClawOpenClawProfile;
    packageBootstrap?: ClawWorkspaceSourceSnapshot;
    packagePreflight?: NonNullable<
      Parameters<typeof buildClawAddPlan>[0]["context"]
    >["packagePreflight"];
  } = {},
) {
  const parsed = parseClawManifest(manifestValue);
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: "@acme/worker",
    version: "1.0.0",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrityKind: "artifact",
    integrity: "sha256:manifest",
    byteLength: 123,
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    openClawProfile: options.openClawProfile,
    packageBootstrap: options.packageBootstrap,
    source,
    context: {
      workspace: options.workspace ?? join(root, "workspace-worker"),
      ...(options.packagePreflight ? { packagePreflight: options.packagePreflight } : {}),
    },
  });
  return { root, plan };
}

export function stateEnv(root: string) {
  return { OPENCLAW_STATE_DIR: join(root, "state") };
}

/** Legacy rows remain readable even though one-way Add no longer writes them. */
export function seedLegacyClawInstall(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions,
): PersistedClawInstall {
  const agentConfigDigest = digestClawOwnedAgentConfig(plan.agent.config);
  const agentOwnedPaths = plan.actions
    .filter((action) => action.kind === "agent")
    .map((action) => action.target);
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<Pick<DB, "claw_installs">>(db)
        .insertInto("claw_installs")
        .values({
          agent_id: plan.agent.finalId,
          schema_version: "openclaw.clawInstallRecord.v2",
          source_kind: plan.claw.kind,
          claw_name: plan.claw.name,
          claw_version: plan.claw.version,
          package_root: plan.claw.packageRoot,
          manifest_path: plan.claw.manifestPath,
          integrity_kind: plan.claw.integrityKind,
          integrity: plan.claw.integrity,
          source_byte_length: plan.claw.byteLength,
          manifest_schema_version: plan.manifestSchemaVersion,
          plan_integrity: plan.planIntegrity,
          workspace: plan.agent.workspace,
          agent_config_digest: agentConfigDigest,
          agent_owned_paths_json: JSON.stringify(agentOwnedPaths),
          bootstrap_source_path: null,
          bootstrap_content_digest: null,
          status: "complete",
          added_at_ms: 123,
          updated_at_ms: 123,
        }),
    );
  }, options);
  return {
    schemaVersion: "openclaw.clawInstallRecord.v2",
    claw: plan.claw,
    manifestSchemaVersion: plan.manifestSchemaVersion,
    planIntegrity: plan.planIntegrity,
    agentId: plan.agent.finalId,
    workspace: plan.agent.workspace,
    agentConfigDigest,
    agentOrigin: "created",
    agentOwnedPaths,
    status: "complete",
    addedAtMs: 123,
    updatedAtMs: 123,
  };
}
