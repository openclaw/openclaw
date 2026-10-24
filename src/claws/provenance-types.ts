import type { ClawStatusEntry } from "../../packages/gateway-protocol/src/schema/claws.js";
import type { CLAW_SCHEMA_VERSION, ClawSourceIdentity } from "./manifest-contract.js";
import type { ClawAgentOrigin } from "./provenance-agent-origin.js";
import type { parseClawInstallRecordSchemaVersion } from "./provenance-schema-version.js";

type ClawInstallStatus = ClawStatusEntry["status"];

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
