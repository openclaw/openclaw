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
import type { TemplateManifest, TemplatePackage, TemplateDependency } from "./schema.js";

export { TEMPLATE_BOOTSTRAP_FILE_NAMES, type TemplateDiagnostic } from "./manifest-contract.js";
export type { TemplateSourceIdentity } from "./manifest-contract.js";

export type {
  TemplateCronJob,
  TemplateManifest,
  TemplateMcpServer,
  TemplatePackage,
  TemplateDependency,
  TemplateBundledDependency,
} from "./schema.js";

export const TEMPLATE_ADD_PLAN_SCHEMA_VERSION = "openclaw.templateAddPlan.v1" as const;
export const TEMPLATE_INSPECT_RESULT_SCHEMA_VERSION = "openclaw.templateInspect.v1" as const;
export const TEMPLATE_OUTPUT_STABILITY = "experimental" as const;

type TemplateExtensionFormat = TemplateAppliedExtension["format"];

export type ResolvedTemplatePackage = TemplatePackage & {
  integrity: string;
  extension?: TemplateAppliedExtension;
};

export type TemplateBundledSourceSnapshot = {
  kind: "skill" | "plugin";
  path: string;
  name?: string;
  snapshot: import("./dependency-directory.js").TemplateDirectorySnapshot;
};

export type TemplatePluginCapabilityGrantsById = Record<string, PluginOperatorGrants>;

export type TemplatePackagePreflightResult = {
  ok: boolean;
  action?: "install" | "reuse";
  integrity?: string;
  installId?: string;
  warning?: string;
  installPolicyWarningDigest?: string;
  installedIntegrity?: string;
  installedAt?: string;
  installedVersion?: string;
  name?: string;
  snapshot?: import("./dependency-directory.js").TemplateDirectorySnapshot;
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
  pkg: TemplateDependency,
  workspace: string,
  source?: {
    packageRoot: string;
    snapshot?: import("./dependency-directory.js").TemplateDirectorySnapshot;
  },
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

type TemplateSourceSnapshot = {
  manifest: TemplateSourceFileSnapshot;
  bundledSources?: TemplateBundledSourceSnapshot[];
  workspaceSources: TemplateWorkspaceSourceSnapshot[];
  packageBootstrap?: TemplateWorkspaceSourceSnapshot;
};

export type TemplateReadResult =
  | {
      ok: true;
      manifest: TemplateManifest;
      templateMarkdownBody?: Buffer;
      packageBootstrap?: TemplateWorkspaceSourceSnapshot;
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
  blockers: TemplateDiagnostic[];
  diagnostics: TemplateDiagnostic[];
};
