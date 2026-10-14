import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import type { CronJob } from "../../packages/gateway-protocol/src/schema/cron.types.js";

export type CronAgentScope = {
  agentId?: string | null;
  sessionKey?: string | null;
};

/** Optional zero-token shell gate before cron payload execution (#112371). */
export type CronJobPrecheck = {
  kind?: "exec";
  command: string;
  cwd?: string;
  timeoutMs?: number;
  contract?: "exit-code" | "stdout-prefix" | "dual";
  workExitCodes?: number[];
  noWorkExitCodes?: number[];
  workStdoutPrefix?: string;
  noWorkStdoutPrefix?: string;
  onError?: "fail" | "skip";
};

/** Invalid config-backed cron job captured for quarantine instead of runtime load. */
export type QuarantinedCronConfigJob = {
  sourceIndex: number;
  reason: string;
  job?: Record<string, unknown>;
  raw?: unknown;
  state?: Record<string, unknown>;
  updatedAtMs?: number;
  scheduleIdentity?: string;
};

/** Durable recovery record for a cron job skipped during store loading. */
export type CronQuarantinedJob = QuarantinedCronConfigJob & { quarantinedAtMs: number };

/** Optional dynamic-cadence bounds for one cron job. */
export type CronPacing = SchemaContract<NonNullable<CronJob["pacing"]>>;

/** Shared persisted cron job envelope used by runtime and external config shapes. */
export type CronJobBase<TSchedule, TSessionTarget, TWakeMode, TPayload, TDelivery, TFailureAlert> =
  {
    id: string;
    agentId?: string;
    sessionKey?: string;
    name: string;
    description?: string;
    enabled: boolean;
    deleteAfterRun?: boolean;
    createdAtMs: number;
    updatedAtMs: number;
    schedule: TSchedule;
    pacing?: CronPacing;
    sessionTarget: TSessionTarget;
    wakeMode: TWakeMode;
    payload: TPayload;
    /** Optional shell gate before payload execution (skip LLM when no work). */
    precheck?: CronJobPrecheck;
    delivery?: TDelivery;
    failureAlert?: TFailureAlert;
  };
