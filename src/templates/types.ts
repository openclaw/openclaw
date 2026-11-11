import type { PluginOperatorGrants } from "../../packages/gateway-protocol/src/schema/plugins.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { PluginAcceptedDeclaredSurface } from "../config/types.plugins.js";
import type { CronJobCreate } from "../cron/types.js";
import type {
  TEMPLATE_SCHEMA_VERSION,
  TemplateAppliedExtension,
  TemplateDiagnostic,
  TemplateSourceIdentity,
} from "./manifest-contract.js";
import type {
  TemplateManifest,
  TemplateOpenClawExtension,
  TemplateOpenClawProfile,
  TemplatePackage,
} from "./schema.js";

export { TEMPLATE_BOOTSTRAP_FILE_NAMES, type TemplateDiagnostic } from "./manifest-contract.js";
export type { TemplateSourceIdentity } from "./manifest-contract.js";

export type {
  TemplateCronJob,
  TemplateManifest,
  TemplateMcpServer,
  TemplateOpenClawExtension,
  TemplateOpenClawProfile,
  TemplatePackage,
} from "./schema.js";

export const TEMPLATE_ADD_PLAN_SCHEMA_VERSION = "openclaw.templateAddPlan.v1" as const;
export const TEMPLATE_INSPECT_RESULT_SCHEMA_VERSION = "openclaw.templateInspect.v1" as const;
export const TEMPLATE_OUTPUT_STABILITY = "experimental" as const;

type TemplateExtensionFormat = TemplateOpenClawExtension["format"];

export type ResolvedTemplatePackage = TemplatePackage & {
  integrity: string;
  extension?: TemplateAppliedExtension;
};

export type TemplatePluginCapabilityGrantsById = Record<string, PluginOperatorGrants>;

export type TemplatePackagePreflightResult = {
  ok: boolean;
  action?: "install" | "reuse";
  integrity?: string;
  installId?: string;
  warning?: string;
  installedIntegrity?: string;
  installedAt?: string;
  installedVersion?: string;
  code?: string;
  message?: string;
  requirements?: TemplateLocalPrerequisite[];
  detectedFormat?: TemplateExtensionFormat;
  mapped?: string[];
  unavailable?: string[];
  adapterIdentity?: string;
  declaredCapabilities?: PluginAcceptedDeclaredSurface;
  capabilityGrants?: PluginOperatorGrants;
  capabilityGrantsByPluginId?: TemplatePluginCapabilityGrantsById;
};

export type TemplatePackagePreflight = (
  pkg: TemplatePackage,
  workspace: string,
) => Promise<TemplatePackagePreflightResult>;

export type TemplateWorkspaceSourceSnapshot = {
  sourcePath: string;
  realPath: string;
  byteLength: number;
  digest: string;
};

type TemplateSourceFileSnapshot = {
  byteLength: number;
  digest: string;
};

type TemplateProfileSourceSnapshot = TemplateSourceFileSnapshot & {
  sourcePath: string;
};

type TemplateSourceSnapshot = {
  manifest: TemplateSourceFileSnapshot;
  openClawProfile?: TemplateProfileSourceSnapshot;
  workspaceSources: TemplateWorkspaceSourceSnapshot[];
  packageBootstrap?: TemplateWorkspaceSourceSnapshot;
};

export type TemplateReadResult =
  | {
      ok: true;
      manifest: TemplateManifest;
      templateMarkdownBody?: Buffer;
      packageBootstrap?: TemplateWorkspaceSourceSnapshot;
      openClawProfile?: TemplateOpenClawProfile;
      source: TemplateSourceIdentity;
      snapshot: TemplateSourceSnapshot;
      diagnostics: TemplateDiagnostic[];
    }
  | {
      ok: false;
      diagnostics: TemplateDiagnostic[];
    };

export type TemplateAddPlanAction = {
  kind: "agent" | "workspace" | "bootstrap" | "workspaceFile" | "package" | "mcpServer" | "cronJob";
  id: string;
  action: "create" | "write" | "install" | "reuse" | "configure" | "schedule";
  target: string;
  source?: string;
  sourceKind?: "templateMarkdownBody";
  digest?: string;
  details?: Record<string, unknown>;
  automation?: CronJobCreate;
  scratch?: string;
  blocked: boolean;
  reason?: string;
};

export type TemplateExtensionPlan = TemplateOpenClawExtension & {
  detectedFormat?: TemplateExtensionFormat;
  integrity?: string;
  installId?: string;
  ownerAction?: "install" | "reuse";
  requirementState: "satisfied" | "missing-installable" | "conflicting" | "setup-required";
  mapped: string[];
  unavailable: string[];
  adapterIdentity?: string;
  declaredCapabilities?: PluginAcceptedDeclaredSurface;
  capabilityGrants?: PluginOperatorGrants;
  capabilityGrantsByPluginId?: TemplatePluginCapabilityGrantsById;
  blocked: boolean;
};

export type TemplateAddCapabilityChange = {
  kind: "agent" | "package" | "mcpServer" | "cronJob";
  id: string;
  path: string;
  action: "create" | "install" | "reuse" | "configure" | "schedule";
  classification: "escalation";
  requiresDistinctConsent: true;
  reason: string;
  effect: Record<string, unknown>;
  digest: string;
};

export type TemplateLocalPrerequisite =
  | { kind: "environment"; mcpServer: string; name: string }
  | { kind: "oauth"; mcpServer: string }
  | {
      kind: "plugin-setup";
      plugin: string;
      provider: string;
      envVars: string[];
      authMethods: string[];
    };

export type TemplateAddPlan = {
  schemaVersion: typeof TEMPLATE_ADD_PLAN_SCHEMA_VERSION;
  manifestSchemaVersion: typeof TEMPLATE_SCHEMA_VERSION;
  stability: typeof TEMPLATE_OUTPUT_STABILITY;
  dryRun: true;
  mutationAllowed: false;
  planIntegrity: string;
  template: TemplateSourceIdentity;
  agent: {
    requestedId: string;
    finalId: string;
    workspace: string;
    config: AgentConfig & { workspace: string };
  };
  summary: {
    totalActions: number;
    agentActions: number;
    workspaceActions: number;
    packageActions: number;
    mcpServerActions: number;
    cronJobActions: number;
    blockedActions: number;
    capabilityEscalations: number;
  };
  actions: TemplateAddPlanAction[];
  capabilityChanges: TemplateAddCapabilityChange[];
  readiness: {
    ready: boolean;
    requirements: TemplateLocalPrerequisite[];
  };
  extensions?: TemplateExtensionPlan[];
  blockers: TemplateDiagnostic[];
  diagnostics: TemplateDiagnostic[];
};
