import type { ExecDenylistEntry } from "./exec-approvals-denylist.js";
import type { ExecAsk, ExecSecurity } from "./exec-approvals.js";
import type { ExecAllowlistEntry } from "./exec-approvals.types.js";

export type ExecApprovalsDefaults = {
  security?: ExecSecurity;
  ask?: ExecAsk;
  askFallback?: ExecSecurity;
  autoAllowSkills?: boolean;
  denylist?: ExecDenylistEntry[];
};

export type ExecApprovalsAgent = ExecApprovalsDefaults & {
  allowlist?: ExecAllowlistEntry[];
};

export type ExecApprovalsFile = {
  version: 1;
  socket?: {
    path?: string;
    token?: string;
  };
  defaults?: ExecApprovalsDefaults;
  agents?: Record<string, ExecApprovalsAgent>;
};

export type ExecApprovalsSnapshot = {
  path: string;
  exists: boolean;
  raw: string | null;
  file: ExecApprovalsFile;
  hash: string;
};

export type ExecApprovalsResolved = {
  path: string;
  socketPath: string;
  token: string;
  defaults: Required<ExecApprovalsDefaults>;
  agent: Required<ExecApprovalsDefaults>;
  agentSources: {
    security: string | null;
    ask: string | null;
    askFallback: string | null;
  };
  allowlist: ExecAllowlistEntry[];
  denylist: ExecDenylistEntry[];
  file: ExecApprovalsFile;
};
