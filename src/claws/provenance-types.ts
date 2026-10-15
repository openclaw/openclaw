import type { CLAW_SCHEMA_VERSION, ClawSourceIdentity } from "./manifest-contract.js";
import type { ClawAgentOrigin } from "./provenance-agent-origin.js";
import type { parseClawInstallRecordSchemaVersion } from "./provenance-schema-version.js";
import type { ClawAddPlan } from "./types.js";

export type ClawInstallRecordUpdate = Pick<
  ClawAddPlan,
  "claw" | "manifestSchemaVersion" | "planIntegrity"
> & {
  agent: Pick<ClawAddPlan["agent"], "finalId" | "workspace" | "config">;
  actions: Array<Pick<ClawAddPlan["actions"][number], "kind" | "target" | "digest" | "details">>;
};

export type ClawOrphanWorkspace = { workspace: string; updatedAtMs: number };

export type ClawInstallStatus =
  | "pending"
  | "workspace_ready"
  | "config_committed"
  | "complete"
  | "partial";

export type PersistedClawInstall = {
  schemaVersion: ReturnType<typeof parseClawInstallRecordSchemaVersion>;
  claw: ClawSourceIdentity;
  manifestSchemaVersion: typeof CLAW_SCHEMA_VERSION;
  planIntegrity: string;
  agentId: string;
  workspace: string;
  agentConfigDigest: string;
  agentOrigin: ClawAgentOrigin;
  agentOwnedPaths: string[];
  bootstrap?: { sourcePath: string; contentDigest: string };
  status: ClawInstallStatus;
  addedAtMs: number;
  updatedAtMs: number;
};
