/** Host-owned event admission and settlement contracts; no live reply/Gateway imports. */
import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import type { MessagingToolSend } from "../../agents/embedded-agent-messaging.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { CronStoredJob } from "../../cron/types.js";
import type {
  SourceDeliveryOutcome,
  SourceDeliveryPlan,
} from "../../infra/outbound/source-delivery-plan.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { NormalizeReplySkipReason } from "./normalize-reply-skip-reason.js";

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
  error?: string;
  nextCheckMs?: number;
  sourceDeliveryOutcome?: SourceDeliveryOutcome;
  deliveryAttempted?: boolean;
  deliveryAmbiguous?: boolean;
  deliverySuppressionReason?: NormalizeReplySkipReason;
  admissionDeferred?: boolean;
};
export type SessionEventReceipt = {
  id: string;
  cancel: () => boolean;
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
  settings?: Readonly<Pick<SessionEntry, "permissionMode" | "toolOverrides">> | undefined;
  toolsAllow?: string[];
  agentId?: string;
  sessionKey?: string;
};

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
  beforeStart?: () => boolean;
  onStarted?: () => void;
  onExecutionStarted?: (info: { runId: string; sessionId?: string; sessionKey: string }) => void;
  capacity?: { suspend: () => void; resume: (signal?: AbortSignal) => Promise<void> };
  beforeDeliver?: () => Promise<void>;
  assertDeliveryCurrent?: () => void;
  sourceDelivery?: SourceDeliveryPlan;
};

/** Producer callbacks stay bound to the queued occurrence, not a later dispatcher. */
export type SessionEventExecution = {
  /** Captured producer and current session policy remain authoritative at final tool I/O. */
  assertCurrent?: () => void;
  beforeStart?: () => Promise<void>;
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
