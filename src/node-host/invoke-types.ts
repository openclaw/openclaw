import type { SkillBinTrustEntry, SystemRunApprovalPlan } from "../infra/exec-approvals.js";

export type SystemRunParams = {
  command: string[];
  rawCommand?: string | null;
  systemRunPlan?: SystemRunApprovalPlan | null;
  cwd?: string | null;
  env?: Record<string, string>;
  timeoutMs?: number | null;
  needsScreenRecording?: boolean | null;
  agentId?: string | null;
  sessionKey?: string | null;
  approved?: boolean | null;
  approvalDecision?: string | null;
  runId?: string | null;
  suppressNotifyOnExit?: boolean | null;
};

export type RunResult = {
  exitCode?: number;
  timedOut: boolean;
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string | null;
  truncated: boolean;
};

export type ExecEventPayload = {
  sessionKey: string;
  runId: string;
  host: string;
  command?: string;
  exitCode?: number;
  timedOut?: boolean;
  success?: boolean;
  output?: string;
  reason?: string;
  suppressNotifyOnExit?: boolean;
};

export type ExecFinishedResult = {
  stdout?: string;
  stderr?: string;
  error?: string | null;
  exitCode?: number | null;
  timedOut?: boolean;
  success?: boolean;
};

export type ExecFinishedEventParams = {
  sessionKey: string;
  runId: string;
  commandText: string;
  result: ExecFinishedResult;
  suppressNotifyOnExit?: boolean;
};

export type SkillBinsProvider = {
  /**
   * Return the set of skill-declared bins that are trusted for exec on behalf
   * of the given agent. Providers should resolve each bin to an absolute path
   * in the current environment and return one `SkillBinTrustEntry` per (name,
   * resolvedPath) pair.
   *
   * @param agentId
   *   Agent this lookup is for. When omitted, providers fall back to the
   *   union of bins across all agents, which preserves legacy behavior but
   *   disables per-agent exec isolation. Call sites on the exec approval
   *   path MUST pass the active agentId so a skill in one agent's workspace
   *   does not leak an auto-allow into a different agent.
   * @param force
   *   Bypass any TTL cache and force a fresh fetch.
   */
  current(agentId?: string, force?: boolean): Promise<SkillBinTrustEntry[]>;
};
