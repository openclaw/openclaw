import type {
  QuestionRecord,
  QuestionResolvedEvent,
} from "../../../packages/gateway-protocol/src/index.js";
import type { RestartRecoveryOperatorSource } from "../../gateway/operator-run-recovery-source.schema.js";
import type { DurableQuestionSessionBinding } from "../../gateway/question-session-access.types.js";
import type { UserChannelAuthorizationReference } from "../../state/user-profiles.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";

type QuestionContinuationProvenance = {
  issuer: "operator" | "channel";
  sourceRunId: string;
  recoverySource?: RestartRecoveryOperatorSource;
  channelAuthorizationReference?: UserChannelAuthorizationReference;
  delivery?: DeliveryContext;
};

export type DurableQuestion = {
  record: QuestionRecord;
  sessionKey: string;
  sessionId: string;
  lifecycleRevision: string;
  provenance: QuestionContinuationProvenance;
  sessionBinding: DurableQuestionSessionBinding;
  resolutionId?: string;
  /** Canonical terminal receipt deadline; never renewed by observation or restore. */
  retainUntilMs?: number;
  continuation: {
    status: "pending" | "owed" | "claimed" | "settled" | "interrupted" | "blocked";
    runId?: string;
    gatewayEpoch?: string;
    reason?: string;
  };
};

export type SessionQuestionOperation =
  | { kind: "register"; question: DurableQuestion }
  | { kind: "get"; id: string }
  | { kind: "list" }
  | {
      kind: "settle";
      id: string;
      expectedQuestion: DurableQuestion;
      outcome: QuestionResolvedEvent;
      resolutionId: string;
      resolvedBy?: string;
    }
  | {
      kind: "claim";
      id: string;
      expectedQuestion: DurableQuestion;
      runId: string;
      gatewayEpoch: string;
    }
  | {
      kind: "finish";
      id: string;
      expectedQuestion: DurableQuestion;
      runId: string;
      interrupted?: boolean;
      reason?: string;
    }
  | { kind: "block"; id: string; expectedQuestion: DurableQuestion; reason: string }
  | {
      kind: "retire";
      sessionKey: string;
      sessionId: string;
      lifecycleRevision: string;
      resolutionId: string;
    }
  | { kind: "interrupt"; gatewayEpoch: string };

export type SessionQuestionResult = DurableQuestion | DurableQuestion[] | undefined;

export type SessionQuestionReadInput = {
  kind: "session-question-read";
  database: { agentId: string; path: string };
  env: NodeJS.ProcessEnv;
  operation: Extract<SessionQuestionOperation, { kind: "get" | "list" }>;
  custodyBinding?: DurableQuestionSessionBinding;
};
