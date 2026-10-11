import type {
  Question,
  QuestionAnswers,
  QuestionRecord,
  QuestionResolvedEvent,
} from "../../packages/gateway-protocol/src/index.js";
import type { OperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import type { DurableQuestion } from "../config/sessions/session-questions.types.js";
import type { GatewayScheduledJob } from "../infra/gateway-scheduler.js";
import type { GatewayRootWorkAdmissionContinuationScope } from "../process/gateway-work-admission.js";
import type { QuestionRegistrationReservation } from "./question-registration-reservations.js";
import type {
  QuestionClientAuthorization,
  QuestionSessionAccess,
} from "./question-session-access.types.js";

export type DurableQuestionCustody = {
  definition?: DurableQuestion;
  settle: (
    outcome:
      | { status: "answered"; answers: QuestionAnswers; resolvedBy?: string; resolutionId?: string }
      | { status: "cancelled" | "expired"; resolvedBy?: string },
    assertCurrent: () => void,
    assertCustodyCurrent: () => void,
  ) => Promise<{ record: QuestionRecord; resolutionId?: string }>;
  onContinuationOwed: () => void;
};

export type QuestionManagerRequest = {
  registrationReservation?: QuestionRegistrationReservation;
  id?: string;
  questions: Question[];
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  timeoutMs: number;
  /** Canonical worker receipt; restoration must never renew a deadline. */
  storedRecord?: QuestionRecord;
  storedResolutionId?: string;
  durableCustody?: DurableQuestionCustody;
  onResolved?:
    | ((event: QuestionResolvedEvent, observation: QuestionObservation) => void)
    | ((event: QuestionResolvedEvent, observation: QuestionObservation) => Promise<void>);
  sessionAccess?: QuestionSessionAccess;
  /** Host-owned human decision boundary; never accepted from wire data. */
  authorizeClient?: QuestionClientAuthorization;
  isRequesterActive?: () => boolean;
  requesterRun?: OperationalRunInstanceRef;
  /** Trusted handler binds the run; the manager owns expiry and terminal release. */
  registerHumanInputWait?: (isPending: () => boolean) => ((resolved: boolean) => void) | undefined;
};

export type Waiter = () => void;

export type QuestionEntry = {
  record: QuestionRecord;
  durableCustody?: DurableQuestionCustody;
  ordinary: boolean;
  resolutionId?: string;
  job: GatewayScheduledJob;
  waiters: Set<Waiter>;
  onResolved?: QuestionManagerRequest["onResolved"];
  sessionAccess?: QuestionSessionAccess;
  /** Host-owned human decision boundary; never accepted from wire data. */
  authorizeClient?: QuestionClientAuthorization;
  isRequesterActive?: () => boolean;
  requesterRun?: OperationalRunInstanceRef;
  admissionContinuation: GatewayRootWorkAdmissionContinuationScope | null;
  releaseHumanInputWait?: (resolved: boolean) => void;
  committing?: boolean;
  commitUnknown?: boolean;
  retired?: boolean;
  expiryRetryAttempt?: number;
  expiryRetryAtMs?: number;
};

/** Private entry identity. Never reselect a successor by its public question id. */
export type QuestionObservation = {
  readonly record: QuestionRecord;
  readonly ordinary: boolean;
  readonly durableDefinition?: DurableQuestion;
  readonly sessionAccess?: QuestionSessionAccess;
  readonly authorizeClient?: QuestionClientAuthorization;
  isCurrent: () => boolean;
  refreshRequester: () => void;
};
