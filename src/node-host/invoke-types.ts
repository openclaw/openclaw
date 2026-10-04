import type { SystemRunExecutionContext } from "../../packages/gateway-protocol/src/system-run-execution-context.js";
import type { SkillBinTrustEntry, SystemRunApprovalPlan } from "../infra/exec-approvals.js";

export type NodeInvokeRequestPayload = {
  id: string;
  nodeId: string;
  command: string;
  paramsJSON?: string | null;
  timeoutMs?: number | null;
  idempotencyKey?: string | null;
  sessionKey?: string | null;
};

export type SystemRunParams = {
  command: string[];
  rawCommand?: string | null;
  systemRunPlan?: SystemRunApprovalPlan | null;
  cwd?: string | null;
  env?: Record<string, string>;
  executionContext?: SystemRunExecutionContext;
  timeoutMs?: number | null;
  needsScreenRecording?: boolean | null;
  agentId?: string | null;
  sessionKey?: string | null;
  approved?: boolean | null;
  approvalDecision?: string | null;
  approvalSource?: string | null;
  runId?: string | null;
  suppressNotifyOnExit?: boolean | null;
};

export type RunResult = {
  exitCode?: number;
  timedOut: boolean;
  noOutputTimedOut?: boolean;
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

export type SkillBinsProvider = {
  current(force?: boolean): Promise<SkillBinTrustEntry[]>;
};
