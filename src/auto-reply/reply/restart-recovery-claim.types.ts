import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { RequesterOrigin } from "../../agents/requester-origin.js";
import type { RestartRecoveryBeforeAgentReplyState } from "../../config/sessions/restart-recovery-types.js";
import type { SessionEntryTargetPatchScope } from "../../config/sessions/session-accessor.types.js";
import type { SessionActor } from "../../config/sessions/session-actor-contract.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type {
  UserTurnTranscriptRecorder,
  UserTurnTranscriptTarget,
} from "../../sessions/user-turn-transcript.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";
import type { SourceReplyDeliveryMode } from "../get-reply-options.types.js";
import type { AgentTurnRestartClaimCleanup } from "./agent-runner-completion.types.js";

export type ReplyRestartRecoveryClaimController = {
  admitUserTurn: (
    recorder?: UserTurnTranscriptRecorder,
  ) => Promise<"admitted" | "duplicate-source">;
  beginBeforeAgentReply: () => Promise<boolean>;
  checkpointBeforeAgentReply: (params: {
    state?: RestartRecoveryBeforeAgentReplyState;
    pendingFinalDelivery?: {
      context?: DeliveryContext;
      deliveries: NonNullable<SessionEntry["pendingFinalDelivery"]>["deliveries"];
      intentId: string;
      text: string;
    };
  }) => Promise<void>;
  clear: () => Promise<void>;
  prepareCompletionCleanup: (entry: SessionEntry) => AgentTurnRestartClaimCleanup | undefined;
  isArmed: () => Promise<boolean>;
};

export type ReplyRestartRecoveryClaimParams = {
  agentId: string;
  acquireSessionActor: () => Promise<
    | {
        actor: SessionActor;
        target: SessionEntryTargetPatchScope;
      }
    | undefined
  >;
  operatorAuthority?: AdmittedRunOperatorAuthority;
  requesterOrigin?: RequesterOrigin;
  inputProvenance?: InputProvenance;
  admissionRunId?: unknown;
  executionRunId?: string;
  lifecycleGeneration: string | undefined;
  getEntry: () => SessionEntry | undefined;
  getSessionId: () => string;
  isRestartAbort: () => boolean;
  resolveDeliveryContext: (entry: SessionEntry | undefined) => DeliveryContext | undefined;
  requesterAccountId?: unknown;
  requesterSenderId?: unknown;
  resolveUserTurnTarget?: (params: {
    entry: SessionEntry;
    sessionId: string;
    sessionKey: string;
    storePath: string;
  }) => UserTurnTranscriptTarget | undefined;
  sessionKey?: string;
  setEntry: (entry: SessionEntry) => void;
  sameChannelThreadRequired?: boolean;
  sourceTurnId?: unknown;
  strandedReplyRetry?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  storePath?: string;
};
