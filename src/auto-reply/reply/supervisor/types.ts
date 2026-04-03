export type SupervisorEventCategory = "user" | "task" | "tool" | "time" | "system";

export type SupervisorUrgency = "low" | "normal" | "high";

export type SupervisorScope = "foreground" | "background" | "global";

export type SupervisorPhase = "idle" | "planning" | "acting" | "committing" | "waiting";

export type SupervisorInterruptPreference = "free" | "avoid" | "critical";

export type SupervisorInterruptibility = "interruptible" | "atomic";

export type SupervisorRelation =
  | "same_task_supplement"
  | "same_task_correction"
  | "same_task_control"
  | "new_task_replace"
  | "new_task_parallel"
  | "background_relevant"
  | "unrelated";

export type SupervisorAction =
  | "continue"
  | "append"
  | "steer"
  | "pause_and_fork"
  | "abort_and_replace"
  | "defer";

export type SupervisorClassifierKind =
  | "deterministic_pre_route"
  | "legacy_queue_translation"
  | "model_relation_classifier";

export type SupervisorOutcomeSignal =
  | "runtime_applied"
  | "user_corrected"
  | "session_superseded"
  | "deferred_resurfaced"
  | "presentation_planned"
  | "first_visible_scheduled"
  | "first_visible_emitted"
  | "first_visible_skipped_fast_complete"
  | "status_scheduled"
  | "status_skipped"
  | "milestone_prepared"
  | "milestone_skipped"
  | "milestone_scheduled"
  | "milestone_sent"
  | "milestone_failed"
  | "milestone_suppressed_fast_complete";

export type SupervisorPresentationKind = "ack" | "status" | "milestone" | "final";

export type SupervisorFirstVisibleKind = "ack" | "status" | "milestone" | "final";

export type SupervisorPresentationLatencyClass = "reflex" | "interactive" | "deliberative";

export type SupervisorAdaptiveRuntimeProfile = "aggressive" | "balanced" | "conservative";

export type SupervisorPresentationDelivery =
  | "routable_external"
  | "internal_webchat"
  | "unroutable";

export type SupervisorPresentationRuntimeDisposition = "preempting_active_run" | "non_preemptive";

export type SupervisorPresentationTemplateId =
  | "ack.received"
  | "status.continuing"
  | "status.updating_current_task"
  | "status.redirecting_current_task"
  | "status.switching_to_new_task"
  | "status.opening_side_task"
  | "status.defer_for_later";

export type SupervisorMilestoneModelInputDraft = {
  audience_question: string;
  semantic_role: string;
  prompt_hint: string;
  suppress_reason?: string;
};

export type SupervisorMilestonePreparedPrompt = {
  audience_question: string;
  semantic_role: string;
  prompt_hint: string;
};

export type SupervisorPresentationPlanItem = {
  kind: SupervisorPresentationKind;
  enabled: boolean;
  latencyClass: SupervisorPresentationLatencyClass;
  mode: "template" | "model" | "none";
  templateId?: SupervisorPresentationTemplateId;
  reason: string;
  userQuestion?: string;
  semanticRole?: string;
  modelPromptHint?: string;
  /**
   * Planner-layer milestone wording contract for a future model step.
   * This is not a user-visible message and does not mean a milestone was sent.
   */
  modelInputDraft?: SupervisorMilestoneModelInputDraft;
};

export type SupervisorPresentationPlan = {
  profile: SupervisorAdaptiveRuntimeProfile;
  items: SupervisorPresentationPlanItem[];
};

export type SupervisorPresentationSummary = {
  status: {
    planned: boolean;
    scheduled_for_runtime: boolean;
    templateId?: SupervisorPresentationTemplateId;
    suppress_reason?: string;
  };
  milestone: {
    planned: boolean;
    eligible_for_runtime: boolean;
    scheduled_for_runtime: boolean;
    has_model_input_draft: boolean;
    suppress_reason?: string;
  };
};

export type SupervisorDecisionRecordMetadata = {
  configuredQueueMode?: string;
  finalQueueMode?: string;
  hasExplicitQueueMode?: boolean;
  ruleResult?: string;
  modelResult?: string;
  modelLatencyMs?: number;
  /**
   * Planner output attached for later analysis and future runtime consumption.
   * `modelInputDraft` inside the plan is semantic scaffolding, not proof that a
   * model-generated milestone was emitted to the user.
   */
  presentationPlan?: SupervisorPresentationPlan;
  /**
   * Small analysis-friendly summary of the planner result and current runtime
   * scheduling posture.
   */
  presentationSummary?: SupervisorPresentationSummary;
  [key: string]: unknown;
};

export type SupervisorMilestoneRuntimeEnvelope = {
  prompt_slots: {
    audience_question: string;
    semantic_role: string;
    prompt_hint: string;
  };
  planner: {
    suppress_reason?: string;
    semantic_role?: string;
  };
};

export type SupervisorMilestoneRuntimeRequest = {
  kind: "supervisor_milestone";
  prompt_slots: {
    audience_question: string;
    semantic_role: string;
    prompt_hint: string;
  };
  planner: {
    suppress_reason?: string;
    semantic_role?: string;
  };
};

export type SupervisorRuntimeAppliedOutcomePayload = {
  action: SupervisorAction;
  relation?: SupervisorRelation;
  finalQueueMode: string;
};

export type SupervisorPresentationPlannedOutcomePayload = {
  summary?: SupervisorPresentationSummary;
  earlyStatusPolicy?: {
    activationReason: string;
    recommendationLevel: "prioritize" | "observe" | "deprioritize";
    recommendationReason: string;
  };
};

export type SupervisorStatusScheduledOutcomePayload = {
  templateId?: SupervisorPresentationTemplateId;
  earlyStatusPolicy?: {
    activationReason: string;
    recommendationLevel: "prioritize" | "observe" | "deprioritize";
    recommendationReason: string;
  };
};

export type SupervisorFirstVisibleScheduledOutcomePayload = {
  kind: SupervisorFirstVisibleKind;
};

export type SupervisorFirstVisibleEmittedOutcomePayload = {
  kind: SupervisorFirstVisibleKind;
  dispatch_to_first_visible_ms: number;
  templateId?: SupervisorPresentationTemplateId;
  messageId?: string;
};

export type SupervisorFirstVisibleSkippedFastCompleteOutcomePayload = {
  kind: SupervisorFirstVisibleKind;
  dispatch_to_completion_ms: number;
};

export type SupervisorStatusSkippedOutcomePayload = {
  reason?: string;
  earlyStatusPolicy?: {
    activationReason: string;
    recommendationLevel: "prioritize" | "observe" | "deprioritize";
    recommendationReason: string;
  };
};

export type SupervisorMilestonePreparedOutcomePayload = {
  prompt: SupervisorMilestonePreparedPrompt;
  runtimeEnvelope: SupervisorMilestoneRuntimeEnvelope;
  runtimeRequest: SupervisorMilestoneRuntimeRequest;
};

export type SupervisorMilestoneSkippedOutcomePayload = {
  reason: string;
  prompt?: SupervisorMilestonePreparedPrompt;
  runtimeEnvelope?: SupervisorMilestoneRuntimeEnvelope;
  runtimeRequest?: SupervisorMilestoneRuntimeRequest;
};

export type SupervisorMilestoneScheduledOutcomePayload = {
  runtimeRequest: SupervisorMilestoneRuntimeRequest;
};

export type SupervisorMilestoneSentOutcomePayload = {
  runtimeRequest: SupervisorMilestoneRuntimeRequest;
  messageId?: string;
};

export type SupervisorMilestoneFailedOutcomePayload = {
  reason: string;
  runtimeRequest?: SupervisorMilestoneRuntimeRequest;
};

export type SupervisorMilestoneSuppressedFastCompleteOutcomePayload = {
  runtimeRequest: SupervisorMilestoneRuntimeRequest;
};

export type SupervisorUserCorrectedOutcomePayload = {
  correctiveDecisionId: string;
  correctiveRelation?: SupervisorRelation;
  correctiveAction: SupervisorAction;
};

export type SupervisorEvent = {
  type: string;
  category: SupervisorEventCategory;
  source: string;
  timestamp: number;
  payload: {
    text?: string;
    bodyPreview?: string;
    [key: string]: unknown;
  };
  urgency: SupervisorUrgency;
  scope: SupervisorScope;
  relatedTaskId?: string;
  relatedSessionId?: string;
};

export type SupervisorTaskState = {
  sessionKey: string;
  sessionId: string;
  phase: SupervisorPhase;
  interruptPreference: SupervisorInterruptPreference;
  interruptibility: SupervisorInterruptibility;
  isActive: boolean;
  isStreaming: boolean;
  laneSize: number;
};

export type SupervisorPreRouteResult =
  | {
      kind: "deterministic";
      relation: SupervisorRelation;
      action: SupervisorAction;
      reason: string;
    }
  | {
      kind: "model";
      reason: string;
    };

export type SupervisorDecisionRecord = {
  id: string;
  timestamp: number;
  taxonomyVersion: string;
  sessionKey: string;
  sessionId: string;
  taskId?: string;
  event: SupervisorEvent;
  taskStateSnapshot: SupervisorTaskState;
  relation?: SupervisorRelation;
  action: SupervisorAction;
  classifier: {
    kind: SupervisorClassifierKind;
    model?: string;
    confidence?: number;
  };
  rationale: {
    short: string;
    preRoute?: string;
    translation?: string;
  };
  retrieval?: {
    hitCount: number;
  };
  outcome?: {
    status: "pending" | "confirmed" | "corrected";
  };
  metadata?: SupervisorDecisionRecordMetadata;
};

type SupervisorDecisionOutcomeRecordBase = {
  id: string;
  timestamp: number;
  taxonomyVersion: string;
  decisionId: string;
  sessionKey: string;
  sessionId: string;
};

export type SupervisorDecisionOutcomeRecord =
  | (SupervisorDecisionOutcomeRecordBase & {
      signal: "runtime_applied";
      payload: SupervisorRuntimeAppliedOutcomePayload;
    })
  | (SupervisorDecisionOutcomeRecordBase & {
      signal: "user_corrected";
      payload: SupervisorUserCorrectedOutcomePayload;
    })
  | (SupervisorDecisionOutcomeRecordBase & {
      signal: "session_superseded" | "deferred_resurfaced";
      payload: Record<string, unknown>;
    })
  | (SupervisorDecisionOutcomeRecordBase & {
      signal: "presentation_planned";
      payload: SupervisorPresentationPlannedOutcomePayload;
    })
  | (SupervisorDecisionOutcomeRecordBase & {
      signal: "first_visible_scheduled";
      payload: SupervisorFirstVisibleScheduledOutcomePayload;
    })
  | (SupervisorDecisionOutcomeRecordBase & {
      signal: "first_visible_emitted";
      payload: SupervisorFirstVisibleEmittedOutcomePayload;
    })
  | (SupervisorDecisionOutcomeRecordBase & {
      signal: "first_visible_skipped_fast_complete";
      payload: SupervisorFirstVisibleSkippedFastCompleteOutcomePayload;
    })
  | (SupervisorDecisionOutcomeRecordBase & {
      signal: "status_scheduled";
      payload: SupervisorStatusScheduledOutcomePayload;
    })
  | (SupervisorDecisionOutcomeRecordBase & {
      signal: "status_skipped";
      payload: SupervisorStatusSkippedOutcomePayload;
    })
  | (SupervisorDecisionOutcomeRecordBase & {
      signal: "milestone_prepared";
      payload: SupervisorMilestonePreparedOutcomePayload;
    })
  | (SupervisorDecisionOutcomeRecordBase & {
      signal: "milestone_skipped";
      payload: SupervisorMilestoneSkippedOutcomePayload;
    })
  | (SupervisorDecisionOutcomeRecordBase & {
      signal: "milestone_scheduled";
      payload: SupervisorMilestoneScheduledOutcomePayload;
    })
  | (SupervisorDecisionOutcomeRecordBase & {
      signal: "milestone_sent";
      payload: SupervisorMilestoneSentOutcomePayload;
    })
  | (SupervisorDecisionOutcomeRecordBase & {
      signal: "milestone_failed";
      payload: SupervisorMilestoneFailedOutcomePayload;
    })
  | (SupervisorDecisionOutcomeRecordBase & {
      signal: "milestone_suppressed_fast_complete";
      payload: SupervisorMilestoneSuppressedFastCompleteOutcomePayload;
    });

export type SupervisorRelationClassificationInput = {
  event: SupervisorEvent;
  taskState: SupervisorTaskState;
  taxonomyVersion: string;
  candidateRelations?: SupervisorRelation[];
  metadata?: Record<string, unknown>;
};

export type SupervisorRelationClassificationResult = {
  relation: SupervisorRelation;
  confidence?: number;
  rationaleShort?: string;
  classifierKind: SupervisorClassifierKind;
  model?: string;
};

export type SupervisorRelationClassifier = {
  classify(
    input: SupervisorRelationClassificationInput,
  ): Promise<SupervisorRelationClassificationResult>;
};

export type SupervisorTaxonomyEvent = {
  id: string;
  category: SupervisorEventCategory;
  description: string;
  defaultUrgency: SupervisorUrgency;
  defaultScope: SupervisorScope;
  likelyRelations: SupervisorRelation[];
};

export type SupervisorTaxonomyPhase = {
  id: SupervisorPhase;
  summary: string;
  interruptibility: "interruptible" | "mostly_interruptible" | "mostly_avoid" | "atomic";
};

export type SupervisorTaxonomyInterruptPreference = {
  id: SupervisorInterruptPreference;
  summary: string;
};

export type SupervisorTaxonomyRelation = {
  id: SupervisorRelation;
  summary: string;
  meaning: string;
  positiveSignals: string[];
  negativeSignals: string[];
  examples: string[];
  commonConfusions: SupervisorRelation[];
  defaultActionCandidates: SupervisorAction[];
};

export type SupervisorTaxonomyAction = {
  id: SupervisorAction;
  summary: string;
  description: string;
  typicalTriggers: string[];
  runtimeEffects: string[];
};

export type SupervisorTaxonomy = {
  version: string;
  events: SupervisorTaxonomyEvent[];
  phases: SupervisorTaxonomyPhase[];
  interruptPreferences: SupervisorTaxonomyInterruptPreference[];
  relations: SupervisorTaxonomyRelation[];
  actions: SupervisorTaxonomyAction[];
};
