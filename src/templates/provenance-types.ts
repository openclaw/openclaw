import type { TemplateStatusEntry } from "../../packages/gateway-protocol/src/schema/templates.js";
import type { TEMPLATE_SCHEMA_VERSION, TemplateSourceIdentity } from "./manifest-contract.js";
import type { TemplateAgentOrigin } from "./provenance-agent-origin.js";
import type { parseTemplateInstallRecordSchemaVersion } from "./provenance-schema-version.js";

type TemplateInstallStatus = TemplateStatusEntry["status"];

export type PersistedTemplateInstall = {
  schemaVersion: ReturnType<typeof parseTemplateInstallRecordSchemaVersion>;
  template: TemplateSourceIdentity;
  manifestSchemaVersion: typeof TEMPLATE_SCHEMA_VERSION;
  planIntegrity: string;
  agentId: string;
  workspace: string;
  agentConfigDigest: string;
  agentOrigin: TemplateAgentOrigin;
  agentOwnedPaths: string[];
  bootstrap?: { sourcePath: string; contentDigest: string };
  status: TemplateInstallStatus;
  addedAtMs: number;
  updatedAtMs: number;
};
