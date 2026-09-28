import type { ToolProfileId } from "../agents/tool-policy-shared.js";

export const CLAW_SCHEMA_VERSION = 1 as const;

export const CLAW_BOOTSTRAP_FILE_NAMES = [
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "TOOLS.md",
  "HEARTBEAT.md",
] as const;

type ClawDiagnosticLevel = "error" | "warning";

export type ClawDiagnostic = {
  level: ClawDiagnosticLevel;
  code: string;
  phase: "parse" | "schema" | "policy" | "plan" | "mutation";
  path: string;
  message: string;
};

export type ClawOpenClawAgentSettings = {
  model?: { primary: string; fallbacks?: string[] };
  subagents?: { allowAgents?: string[]; delegationMode?: "suggest" | "prefer" };
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
