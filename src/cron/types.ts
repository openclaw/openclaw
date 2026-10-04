import type { SchemaContract } from "../../packages/gateway-protocol/src/schema-contract.js";
import type {
  CronDeliveryPreview as CronDeliveryPreviewWire,
  CronJob as CronJobWire,
  CronRunLogEntry as CronRunLogWireEntry,
  CronUpdateParams as CronUpdateParamsWire,
} from "../../packages/gateway-protocol/src/schema/cron.types.js";
import type { EmbeddedAgentExecutionPhase } from "../agents/embedded-agent-runner/execution-phase.js";
/** Cron scheduling, delivery, diagnostics, and store data contracts. */
import type { FailoverReason } from "../agents/failover/signal.js";
import type { NormalizeReplySkipReason } from "../auto-reply/reply/normalize-reply-skip-reason.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { SessionCreatedActor } from "../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { CronAuthenticatedChannelRequester } from "../gateway/cron-creator-authority-grant.types.js";
import type { HookExternalContentSource } from "../security/external-content.js";
import type { CronRuntimeAuthority } from "./runtime-authority.js";
import type {
  CronScheduledToolCallerOrigin,
  CronScheduledToolPolicy,
  CronToolsAllowExecTarget,
  CronToolsAllowExecTargetRequirement,
} from "./scheduled-tool-policy.js";
import type { CronJobBase, CronPacing } from "./types-shared.js";

export type { CronPacing } from "./types-shared.js";
export type { CronToolsAllowExecTarget } from "./scheduled-tool-policy.js";
export type { CronCompletionStatus } from "./completion-status.js";

/** Supported schedule forms persisted in cron job specs. */
// on-exit watchers belong to the Gateway ProcessSupervisor, outside agent-turn
// teardown; events use the normal cron pipeline and bound-session delivery.
// computeNextRunAtMs returns undefined for on-exit and stream schedules.
// Cron staggerMs=0 keeps exact timing; stream command argv emits trigger lines,
// with match carrying the required JavaScript regex source when mode is "match".
export type CronSchedule = CronJobWire["schedule"];

/** Runtime target that decides whether a job joins main, isolated, or a named session. */
type CronSessionTarget = "main" | "isolated" | "current" | `session:${string}`;

/** Wake policy for main-session jobs waiting on heartbeat/user activity. */
type CronWakeMode = CronJobWire["wakeMode"];

/** Messaging channel id accepted by cron delivery settings. */
export type CronMessageChannel = ChannelId;

/** Delivery mode for job completion output. */
type CronDeliveryMode = "none" | "announce" | "webhook";

/** Completion delivery configuration for cron job output. */
export type CronDelivery = {
  mode: CronDeliveryMode;
  channel?: CronMessageChannel;
  to?: string;
  /** Explicit thread/topic id for channels that support threaded delivery. */
  threadId?: string | number;
  /** Explicit channel account id for multi-account setups (e.g. multiple Telegram bots). */
  accountId?: string;
  bestEffort?: boolean;
  /** Additional webhook destination used when a job must keep chat delivery. */
  completionDestination?: CronCompletionDestination;
  /** Separate destination for failure notifications. */
  failureDestination?: CronFailureDestination;
};

/** Webhook completion destination used alongside chat delivery. */
type CronCompletionDestination = {
  mode: "webhook";
  to?: string;
};

/** Destination override for failed-run notifications. */
type CronFailureDestination = {
  channel?: CronMessageChannel;
  to?: string;
  accountId?: string;
  mode?: "announce" | "webhook";
};

/** Partial failure-destination update shape; null clears individual override fields. */
type CronFailureDestinationPatch = {
  [K in keyof CronFailureDestination]?: CronFailureDestination[K] | null;
};

/** Partial delivery update shape; null clears optional delivery destinations or fields. */
export type CronDeliveryPatch = Partial<Pick<CronDelivery, "mode" | "bestEffort">> & {
  channel?: CronMessageChannel | null;
  to?: string | null;
  threadId?: string | number | null;
  accountId?: string | null;
  completionDestination?: CronCompletionDestination | null;
  failureDestination?: CronFailureDestinationPatch | null;
};

/** Execution outcome, separate from delivery outcome. */
export type CronRunStatus = NonNullable<CronRunLogWireEntry["status"]>;

/** Delivery outcome for completion or failure-notification sends. */
export type CronDeliveryStatus = NonNullable<CronRunLogWireEntry["deliveryStatus"]>;

/** Transport evidence for a primary webhook, including an unacknowledged request. */
export type CronWebhookDeliveryOutcome = {
  status: "delivered" | "not-delivered" | "unknown";
  error?: string;
};

/** Delivery target snapshot recorded for audit/debug output. */
export type CronDeliveryTraceTarget = NonNullable<CronDeliveryTrace["intended"]>;

/** Message-tool target that already sent to the cron delivery destination. */
export type CronDeliveryTraceMessageTarget = NonNullable<
  CronDeliveryTrace["messageToolSentTo"]
>[number];

/** Trace of intended, resolved, and already-sent delivery decisions for one run. */
export type CronDeliveryTrace = NonNullable<CronRunLogWireEntry["delivery"]>;

/** Last failed-run notification delivery state stored on job state and run logs. */
export type CronFailureNotificationDelivery = NonNullable<
  CronRunLogWireEntry["failureNotificationDelivery"]
>;

/** Resolved delivery state recorded with a completed cron run. */
export type CronResolvedDeliveryState = CronFailureNotificationDelivery & {
  deliverySuppressionReason?: NormalizeReplySkipReason;
  failureNotification: CronFailureNotificationDelivery;
};

/** Human-readable delivery target preview for list/detail surfaces. */
export type CronDeliveryPreview = CronDeliveryPreviewWire;

/** Model/provider/usage telemetry attached to cron run results and logs. */
export type CronRunTelemetry = Pick<CronRunLogWireEntry, "model" | "provider" | "usage">;

/** Severity level for persisted cron run diagnostics. */
export type CronRunDiagnosticSeverity = CronRunDiagnostic["severity"];

/** Subsystem that produced a cron run diagnostic entry. */
export type CronRunDiagnosticSource = CronRunDiagnostic["source"];

/** Timestamped diagnostic entry preserved for cron run troubleshooting. */
export type CronRunDiagnostic = CronRunDiagnostics["entries"][number];

/** Bounded diagnostic bundle stored on the run outcome. */
export type CronRunDiagnostics = NonNullable<CronRunLogWireEntry["diagnostics"]>;

/** Explicit execution-error disposition used consistently by retry, history, and alerts. */
export type CronRunErrorClassification =
  | { kind: "reason"; reason: FailoverReason }
  /** `reportedByAgent`: the run's final answer reported AUTOMATION_FAILED; no runtime fault. */
  | { kind: "permanent"; reportedByAgent?: true };

/** Closed producer-authored facts allowed in operator-facing failure notifications. */
export type CronFailureNotificationDetail =
  | { kind: "command-exit"; exitCode: number }
  | { kind: "command-timeout"; mode: "wall-clock" | "no-output" }
  | {
      kind: "script-failure";
      source: "payload" | "trigger";
      code: CronTriggerFailureCode;
    };

/** Execution result used to author persisted state, run logs, and isolated turn results. */
export type CronRunOutcome = {
  status: CronRunStatus;
  error?: string;
  /** True once agent execution begins; retries after this point can replay side effects. */
  executionStarted?: boolean;
  /** Optional classifier for execution errors to guide fallback behavior. */
  errorKind?: "delivery-target";
  errorClassification?: CronRunErrorClassification;
  /** Transient internal detail; never project into persisted or public cron events. */
  failureNotificationDetail?: CronFailureNotificationDetail;
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
  diagnostics?: CronRunDiagnostics;
};

/** One run's requested delay before the same paced job runs again. */
export type CronNextCheckProposal = {
  delayMs: number;
};

/** Embedded-agent execution phase names surfaced to cron watchdog progress. */
export type CronAgentExecutionPhase = EmbeddedAgentExecutionPhase;

/** Watchdog-visible execution metadata for an in-flight cron agent run. */
export type CronAgentExecutionStarted = {
  jobId: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  /** Invocation run id; every attempt registers its embedded handle under it. */
  runId?: string;
  /** True when this runner belongs to a later candidate in the same fallback chain. */
  isFallback?: boolean;
  phase?: CronAgentExecutionPhase;
  provider?: string;
  model?: string;
  backend?: string;
  source?: string;
  tool?: string;
  toolCallId?: string;
  itemId?: string;
};

/** Watchdog update that requires the new execution phase. */
export type CronAgentExecutionPhaseUpdate = CronAgentExecutionStarted & {
  phase: CronAgentExecutionPhase;
};

/** Failure alert policy persisted on a cron job. */
export type CronFailureAlert = Exclude<NonNullable<CronJobWire["failureAlert"]>, false>;

/** Partial failure-alert update; null clears an inherited field override. */
export type CronFailureAlertPatch = {
  [K in keyof CronFailureAlert]?: CronFailureAlert[K] | null;
};

/** Payload variants cron can execute in main-session or detached modes. */
export type CronPayload =
  | Exclude<CronJobWire["payload"], { kind: "agentTurn" | "heartbeat" }>
  | (Extract<CronJobWire["payload"], { kind: "agentTurn" }> & CronExternalContent)
  // System-owned heartbeat monitor: execution requests an interval heartbeat
  // wake. Gateway-converged only; not accepted from client create/patch APIs.
  | ({ kind: "heartbeat" } & CronPayloadToolAllow);

/** Partial payload update shape used by cron patch/edit flows. */
export type CronPayloadPatch =
  | Exclude<CronPayloadPatchWire, { kind: "agentTurn" }>
  | (Extract<CronPayloadPatchWire, { kind: "agentTurn" }> & CronExternalContent)
  // Representable so the service can reject it with a typed boundary error;
  // transports and tools never accept it.
  | ({ kind: "heartbeat" } & CronPayloadToolAllowPatch);

export function isSystemOwnedCronPayloadKind(kind: unknown): kind is "heartbeat" {
  return kind === "heartbeat";
}

type CronPayloadToolAllow = {
  /** Legacy per-job tool list retained for rollback, ignored during execution. */
  toolsAllow?: string[];
  /** Legacy marker distinguishing auto-stamped lists from explicitly authored lists. */
  toolsAllowIsDefault?: boolean;
};

type CronPayloadToolAllowPatch = {
  toolsAllow?: string[] | null;
  toolsAllowIsDefault?: boolean;
};

type CronPayloadPatchWire = NonNullable<CronUpdateParamsWire["patch"]["payload"]>;

type CronExternalContent = {
  /** Immutable external hook provenance for async dispatch. */
  externalContentSource?: HookExternalContentSource;
};

/** Mutable runtime state persisted beside the immutable cron job spec. */
// scheduleActivatedAtMs fences catch-up to slots belonging to the active schedule;
// edits must not invent missed work. Without activation, every computed slot is real.
// streamSourceIdentity survives child restarts but rotates atomically on
// disable/remove/replace, fencing same-schedule ABA admission.
export type CronJobState = Omit<
  CronJobWire["state"],
  "deliverySuppressionReason" | "lastStatus"
> & {
  /** Exact startup catch-up slot protected from future-slot repair across restarts. */
  startupCatchupAtMs?: number;
  /** Exact paced completion slot protected from future-slot repair until consumed. */
  pacedNextRunAtMs?: number;
  /** Exact occurrence retained across a manual run; authored one-shots survive pause. */
  forcePreservedNextRunAtMs?: number;
  /** Durable pre-admission reservation. Cleared on restart without recording a run. */
  queuedAtMs?: number;
  /** Exact receipt awaiting scheduler reconciliation, even after execution authority closes. */
  runningReceiptId?: string;
  /** Nonce for a committed schedule edit during the pending run. */
  runningScheduleChangeId?: string;
  /**
   * Unresolved recovery scope and last notified signature, when an alert was requested.
   * `repair` records the owner-conversation repair request that replaced the streak's first
   * alert, and `alerted` that its fallback alert was sent. It lasts until the job succeeds,
   * so a streak is repaired at most once.
   */
  failureAlertIncident?: {
    signature?: string;
    scope: "run" | "trigger";
    repair?: { atMs: number; alerted?: true };
  };
  /** Fences notification settlement when multiple cycles share a timestamp. */
  lastFailureNotificationId?: string;
  /** Number of consecutive schedule computation errors. Auto-disables job after threshold. */
  scheduleErrorCount?: number;
  /** @deprecated Use lastRunStatus. */
  lastStatus?: "ok" | "error" | "skipped";
  /** Intentional non-delivery reason for the last run, when recorded by the dispatcher. */
  deliverySuppressionReason?: NormalizeReplySkipReason;
};

type CronTrigger = SchemaContract<NonNullable<CronJobWire["trigger"]>>;

/**
 * Closed failure taxonomy for trigger-script evaluation. Mirrors the code-mode
 * failure codes plus the trigger tool budget; trigger-script.ts asserts the
 * union stays in sync at compile time. Lives here (leaf module) so the cron
 * service contract never imports the agents runtime.
 */
export type CronTriggerFailureCode =
  | "aborted"
  | "invalid_input"
  | "runtime_unavailable"
  | "timeout"
  | "output_limit_exceeded"
  | "snapshot_limit_exceeded"
  | "internal_error"
  | "plugin_reload_failed"
  | "tool_budget_exceeded";

/** Result union returned by the cron trigger-script evaluator. */
export type CronTriggerEvaluationResult =
  | { kind: "evaluated"; fire: boolean; message?: string; state?: unknown }
  | { kind: "busy" }
  | { kind: "error"; code: CronTriggerFailureCode; error: string };

/** Public cron job contract with spec fields and mutable run state. */
export type CronJob = CronJobBase<
  CronSchedule,
  CronSessionTarget,
  CronWakeMode,
  CronPayload,
  CronDelivery,
  CronFailureAlert | false
> & {
  declarationKey?: string;
  displayName?: string;
  owner?: {
    agentId?: string;
    sessionKey?: string;
    /** Authenticated account that created this scheduled authority envelope. */
    accountId?: string;
  };
  /** Server-authored provenance for requester-scoped scheduled tool authority. */
  scheduledToolPolicy?: CronScheduledToolPolicy;
  trigger?: CronTrigger;
  state: CronJobState;
};

/** Store-only proof omitted from public Gateway results and the CronJob wire/type contract. */
export type CronToolsAllowProvenance =
  | {
      version: 1;
      source: "final-executable-surface";
      /** Store-private creator origin; missing legacy facts normalize to unknown. */
      callerOrigin?: CronScheduledToolCallerOrigin;
      channelRequester?: CronAuthenticatedChannelRequester;
    }
  | ({
      version: 1;
      source: "authenticated-requester";
    } & (
      | {
          /** Authenticated creator origin captured independently of the tool surface. */
          callerOrigin: CronScheduledToolCallerOrigin;
          channelRequester?: CronAuthenticatedChannelRequester;
        }
      | {
          callerOrigin?: never;
          channelRequester: CronAuthenticatedChannelRequester;
        }
    ));

/** Persisted row shape; public Gateway and wire contracts use CronJob. */
export type CronStoredJob = CronJob & {
  /** Immutable revisions inherited from the authorized creator session, never human mutation authority. */
  skillLibrarySelections?: SessionEntry["skillLibrarySelections"];
  /** Immutable creator provenance stamped by the trusted cron creation seam. */
  createdActor?: SessionCreatedActor;
  toolsAllowProvenance?: CronToolsAllowProvenance;
  toolsAllowExecTarget?: CronToolsAllowExecTarget;
  /** Legacy expected execution pin retained for rollback. */
  toolsAllowExecTargetRequirement?: CronToolsAllowExecTargetRequirement;
  /** Legacy runtime snapshot retained for rollback and omitted from public contracts. */
  runtimeAuthority?: CronRuntimeAuthority;
  /** Legacy runtime snapshot recovery marker retained for rollback. */
  runtimeAuthorityRecoveryRequired?: true;
};

/** Versioned cron store file shape. */
export type CronStoreFile = {
  version: 1;
  jobs: CronStoredJob[];
};

type CronJobStateInput = Partial<
  Omit<
    CronJobState,
    | "autoDisabled"
    | "scheduleActivatedAtMs"
    | "streamSourceIdentity"
    | "runningReceiptId"
    | "runningScheduleChangeId"
  >
>;

/** Create input accepted by cron APIs before id/timestamps/state are assigned. */
export type CronJobCreate = Omit<
  CronJob,
  "id" | "createdAtMs" | "updatedAtMs" | "state" | "scheduledToolPolicy"
> & {
  /** Internal callers can reserve a durable id before creation; public cron.add omits this. */
  id?: string;
  state?: CronJobStateInput;
};

/** Patch input accepted by cron APIs without allowing immutable identity fields. */
export type CronJobPatch = Partial<
  Omit<
    CronJob,
    | "id"
    | "createdAtMs"
    | "state"
    | "payload"
    | "delivery"
    | "failureAlert"
    | "declarationKey"
    | "displayName"
    | "owner"
    | "scheduledToolPolicy"
    | "pacing"
    | "trigger"
  >
> & {
  displayName?: string | null;
  pacing?: CronPacing | null;
  trigger?: CronTrigger | null;
  payload?: CronPayloadPatch;
  delivery?: CronDeliveryPatch;
  failureAlert?: CronFailureAlertPatch | false | null;
  state?: CronJobStateInput;
};
