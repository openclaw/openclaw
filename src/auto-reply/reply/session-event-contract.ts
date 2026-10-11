/** Host-owned event admission and settlement contracts; no live reply/Gateway imports. */
import type { SessionEntryCreationOperation } from "../../config/sessions/session-accessor.sqlite-entry-cache.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { ExecRequestOwner } from "../../infra/exec-request-context.js";
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
  deliveryAttempted?: boolean;
  deliveryAmbiguous?: boolean;
  deliverySuppressionReason?: NormalizeReplySkipReason;
  admissionDeferred?: boolean;
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
  onFailed?: (error: unknown) => void;
  onSuppressed?: (
    reason: "send-policy" | "room-event" | "silent" | "message-tool-only" | "aborted",
  ) => void;
  onStarted: (runId: string) => void;
  onTerminal: (runId: string, outcome: "completed" | "failed" | "aborted") => void | Promise<void>;
};
