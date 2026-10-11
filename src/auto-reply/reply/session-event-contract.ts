/** Host-owned event admission and settlement contracts; no live reply/Gateway imports. */
import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import type { MessagingToolSend } from "../../agents/embedded-agent-messaging.types.js";
import type { SessionEntryCreationOperation } from "../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { CronRunOutcome, CronStoredJob } from "../../cron/types.js";
import type { ExecRequestOwner } from "../../infra/exec-request-context.js";
import type {
  SourceDeliveryOutcome,
  SourceDeliveryPlan,
} from "../../infra/outbound/source-delivery-plan.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { NormalizeReplySkipReason } from "./normalize-reply-skip-reason.js";
import type { ReplyOperation } from "./reply-run-registry.contracts.js";

export type SessionEventSource =
  | "exec"
  | "node"
  | "task"
  | "hook"
  | "restart"
  | "session"
  | "device"
  | "plugin"
  | "cron";
export type SessionEventOutcome = {
  status: "completed" | "failed" | "cancelled";
  executionStarted: boolean;
  delivered: boolean;
  summary?: string;
  nextCheckMs?: number;
  sourceDeliveryOutcome?: SourceDeliveryOutcome;
  error?: string;
  deliveryAttempted?: boolean;
  deliveryAmbiguous?: boolean;
  deliverySuppressionReason?: NormalizeReplySkipReason;
  admissionDeferred?: boolean;
  admissionDeferredReason?: CronRunOutcome["admissionDeferredReason"];
};
export type SessionEventReceipt = {
  id: string;
  cancel: () => boolean;
  /** Resolves after ordinary turn adoption or committed follow-up queue admission. */
  accepted: Promise<{ ok: true } | { ok: false; error: string }>;
  settled: Promise<SessionEventOutcome>;
};

export type SessionEventTarget = {
  /** Host-captured producer authority, never a structural plugin input. */
  assertCurrent?: () => void;
  /** Captured internal-only completion policy for a retained producer. */
  deliver?: boolean;
  sessionId: string;
  storePath?: string;
  lifecycleRevision?: string;
  generation: string;
  deliveryContext?: DeliveryContext;
  chatType?: SessionEntry["chatType"];
  settings?: Readonly<Pick<SessionEntry, "permissionMode" | "toolOverrides">> | undefined;
  toolsAllow?: string[];
  agentId?: string;
  sessionKey?: string;
};

export type SessionEventSourcePolicy = Readonly<
  Pick<SessionEventTarget, "toolsAllow" | "settings">
>;

/** Cron-owned snapshot and live occurrence fence shared with ordinary reply admission. */
export type ScheduledSessionAutomation = {
  job: CronStoredJob;
  admissionSource: NonNullable<AdmittedRunContext["admissionSource"]>;
  executionIdentity?: import("../../cron/service/state.js").CronExecutionIdentityAdmission;
  deliveryAttemptFence?:
    | import("../../cron/delivery-attempt-fence.js").CronCompletionDeliveryFence
    | null;
  assertCurrent: () => void;
  /** Refresh durable occurrence authority before admission or an asynchronous effect. */
  prepare?: () => Promise<void>;
  /** Selected absent notices share the receiver's exact ordinary creation operation. */
  bindSessionCreation?: (operation: SessionEntryCreationOperation) => () => void;
  beforeStart?: (
    operation?: ReplyOperation,
  ) => boolean | NonNullable<CronRunOutcome["admissionDeferredReason"]>;
  /** Retain an on-exit occurrence in its current admission until foreground work settles. */
  waitForIdle?: (signal?: AbortSignal, operation?: ReplyOperation) => Promise<void>;
  onStarted?: () => void;
  onExecutionStarted?: (info: { runId: string; sessionId?: string; sessionKey: string }) => void;
  capacity?: { suspend: () => void; resume: (signal?: AbortSignal) => Promise<void> };
  beforeDeliver?: () => Promise<void>;
  assertDeliveryCurrent?: () => void;
  sourceDelivery?: SourceDeliveryPlan;
};

/** Producer callbacks stay bound to the queued occurrence, not a later dispatcher. */
export type SessionEventExecution = {
  /** Original command custody survives process eviction and deferred reply execution. */
  execRequestOwners?: readonly ExecRequestOwner[];
  /** Background producers inherit this turn's automatic-delivery restriction. */
  deliver?: false;
  /** Captured producer and current session policy remain authoritative at final tool I/O. */
  assertCurrent?: () => void;
  /** Bind the original absent target to the normal session writer before its first commit. */
  bindSessionCreation?: (operation: SessionEntryCreationOperation) => () => void;
  beforeStart?: () => Promise<void>;
  /** Scheduled-only final admission before native execution binding. */
  beforeScheduledStart?: (runId: string) => Promise<void>;
  onFailed?: (error: unknown) => void;
  onSuppressed?: (
    reason: "send-policy" | "room-event" | "silent" | "message-tool-only" | "aborted",
  ) => void;
  onStarted: (runId: string) => void;
  onTerminal: (
    runId: string,
    outcome: "completed" | "failed" | "aborted",
    deliveryEvidence?: {
      didSendViaMessagingTool?: boolean;
      messagingToolSentTargets?: MessagingToolSend[];
    },
  ) => void | Promise<void>;
};
