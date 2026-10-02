// Shared types for grouped OpenClaw Claw manifests and read-only add plans.
import type { AgentConfig } from "../config/types.agents.js";
import type { CLAW_SCHEMA_VERSION, ClawDiagnostic } from "./manifest-contract.js";
import type {
  ClawManifest,
  ClawOpenClawExtension,
  ClawOpenClawProfile,
  ClawPackage,
} from "./schema.js";

export {
  CLAW_BOOTSTRAP_FILE_NAMES,
  CLAW_SCHEMA_VERSION,
  type ClawDiagnostic,
} from "./manifest-contract.js";

export type {
  ClawCronJob,
  ClawManifest,
  ClawMcpServer,
  ClawOpenClawExtension,
  ClawOpenClawProfile,
  ClawPackage,
} from "./schema.js";

export const CLAW_ADD_PLAN_SCHEMA_VERSION = "openclaw.clawAddPlan.v1" as const;
export const CLAW_INSPECT_RESULT_SCHEMA_VERSION = "openclaw.clawInspect.v1" as const;
export const CLAW_OUTPUT_STABILITY = "experimental" as const;

type ClawExtensionFormat = ClawOpenClawExtension["format"];

export type ClawAppliedExtension = {
  id: string;
  format: ClawExtensionFormat;
  detectedFormat: ClawExtensionFormat;
  mapped: string[];
  unavailable: string[];
  adapterIdentity: string;
};

export type ResolvedClawPackage = ClawPackage & {
  integrity: string;
  extension?: ClawAppliedExtension;
};

export type ClawPackagePreflightResult = {
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
  requirements?: ClawLocalPrerequisite[];
  detectedFormat?: ClawExtensionFormat;
  mapped?: string[];
  unavailable?: string[];
  adapterIdentity?: string;
};

export type ClawPackagePreflight = (
  pkg: ClawPackage,
  workspace: string,
) => Promise<ClawPackagePreflightResult>;

export type ClawSourceIdentity = {
  kind: "package" | "development";
  name: string;
  version: string;
  packageRoot: string;
  manifestPath: string;
  integrityKind: "artifact" | "development-snapshot";
  integrity: string;
  byteLength: number;
};

export type ClawWorkspaceSourceSnapshot = {
  sourcePath: string;
  realPath: string;
  byteLength: number;
  digest: string;
};

type ClawSourceFileSnapshot = {
  byteLength: number;
  digest: string;
};

type ClawProfileSourceSnapshot = ClawSourceFileSnapshot & {
  sourcePath: string;
};

type ClawSourceSnapshot = {
  manifest: ClawSourceFileSnapshot;
  openClawProfile?: ClawProfileSourceSnapshot;
  workspaceSources: ClawWorkspaceSourceSnapshot[];
  packageBootstrap?: ClawWorkspaceSourceSnapshot;
};

export type ClawReadResult =
  | {
      ok: true;
      manifest: ClawManifest;
      clawMarkdownBody?: Buffer;
      packageBootstrap?: ClawWorkspaceSourceSnapshot;
      openClawProfile?: ClawOpenClawProfile;
      legacyOpenClawProfile?: ClawOpenClawProfile;
      source: ClawSourceIdentity;
      snapshot: ClawSourceSnapshot;
      diagnostics: ClawDiagnostic[];
    }
  | {
      ok: false;
      diagnostics: ClawDiagnostic[];
    };

export type ClawAddPlanAction = {
  kind: "agent" | "workspace" | "bootstrap" | "workspaceFile" | "package" | "mcpServer" | "cronJob";
  id: string;
  action: "create" | "write" | "install" | "reuse" | "configure" | "schedule";
  target: string;
  source?: string;
  sourceKind?: "clawMarkdownBody";
  digest?: string;
  details?: Record<string, unknown>;
  blocked: boolean;
  reason?: string;
};

export type ClawExtensionPlan = ClawOpenClawExtension & {
  detectedFormat?: ClawExtensionFormat;
  integrity?: string;
  installId?: string;
  ownerAction?: "install" | "reuse";
  requirementState: "satisfied" | "missing-installable" | "conflicting" | "setup-required";
  mapped: string[];
  unavailable: string[];
  adapterIdentity?: string;
  blocked: boolean;
};

export type ClawAddCapabilityChange = {
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

export type ClawLocalPrerequisite =
  | { kind: "environment"; mcpServer: string; name: string }
  | { kind: "oauth"; mcpServer: string }
  | {
      kind: "plugin-setup";
      plugin: string;
      provider: string;
      envVars: string[];
      authMethods: string[];
    };

export type ClawAddPlan = {
  schemaVersion: typeof CLAW_ADD_PLAN_SCHEMA_VERSION;
  manifestSchemaVersion: typeof CLAW_SCHEMA_VERSION;
  stability: typeof CLAW_OUTPUT_STABILITY;
  dryRun: true;
  mutationAllowed: false;
  planIntegrity: string;
  claw: ClawSourceIdentity;
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
  actions: ClawAddPlanAction[];
  capabilityChanges: ClawAddCapabilityChange[];
  readiness: {
    ready: boolean;
    requirements: ClawLocalPrerequisite[];
  };
  extensions?: ClawExtensionPlan[];
  blockers: ClawDiagnostic[];
  diagnostics: ClawDiagnostic[];
};
