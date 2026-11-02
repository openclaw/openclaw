import type { ToolProfileId } from "../agents/tool-policy-shared.js";

export const TEMPLATE_SCHEMA_VERSION = 1 as const;
export const TEMPLATE_PACKAGE_KINDS = ["skill", "plugin"] as const;
export const TEMPLATE_PACKAGE_SOURCE = "clawhub" as const;
export const TEMPLATE_EXTENSION_FORMATS = ["openclaw", "claude", "codex", "cursor"] as const;

export type TemplatePackageKind = (typeof TEMPLATE_PACKAGE_KINDS)[number];
export type TemplatePackageSource = typeof TEMPLATE_PACKAGE_SOURCE;
type TemplateExtensionFormat = (typeof TEMPLATE_EXTENSION_FORMATS)[number];

export type TemplateAppliedExtension = {
  id: string;
  format: TemplateExtensionFormat;
  detectedFormat: TemplateExtensionFormat;
  mapped: string[];
  unavailable: string[];
  adapterIdentity: string;
};

export type TemplateSourceIdentity = {
  kind: "package" | "development";
  name: string;
  version: string;
  packageRoot: string;
  manifestPath: string;
  integrityKind: "artifact" | "development-snapshot";
  integrity: string;
  byteLength: number;
};

export type TemplateCronJob = {
  id: string;
  name?: string;
  schedule: { cron: string; timezone: string };
  session: "main" | "isolated";
  message: string;
  delivery?: { mode: "none" | "announce"; channel?: "last" };
};

export const TEMPLATE_BOOTSTRAP_FILE_NAMES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
] as const;

type TemplateDiagnosticLevel = "error" | "warning";

export type TemplateDiagnostic = {
  level: TemplateDiagnosticLevel;
  code: string;
  phase: "parse" | "schema" | "policy" | "plan" | "mutation";
  path: string;
  message: string;
};

export type TemplateOpenClawAgentSettings = {
  groupChat?: {
    mentionPatterns?: string[];
  };
  sandbox?: {
    mode?: "off" | "non-main" | "all";
    scope?: "session" | "agent" | "shared";
    workspaceAccess?: "none" | "ro" | "rw";
  };
  tools?: {
    profile?: ToolProfileId;
    allow?: string[];
    alsoAllow?: string[];
    deny?: string[];
    fs?: {
      workspaceOnly?: true;
    };
  };
  memory?: {
    search?: {
      enabled?: boolean;
      rememberAcrossConversations?: boolean;
      sources?: Array<"memory" | "sessions">;
    };
  };
  heartbeat?: {
    every?: string;
    activeHours?: {
      start?: string;
      end?: string;
      timezone?: string;
    };
    lightContext?: boolean;
    isolatedSession?: boolean;
    timeoutSeconds?: number;
  };
  humanDelay?: {
    mode?: "off" | "natural" | "custom";
    minMs?: number;
    maxMs?: number;
  };
};
