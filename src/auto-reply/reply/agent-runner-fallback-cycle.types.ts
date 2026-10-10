import type { PreparedAgentRunAdmission } from "../../agents/admitted-run-context.js";
import type { BootstrapContextRunKind } from "../../agents/bootstrap-mode.js";
import type { RunEntryCandidateOptions } from "../../agents/embedded-agent-runner/run-entry.js";
import type { DeferredEmbeddedRunLifecycleManager } from "../../agents/embedded-agent-runner/run/deferred-lifecycle-owner.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import type { FastModeAutoProgressState } from "../../agents/fast-mode.js";
import type { CompactionRequestBudget } from "../../agents/sessions/compaction/request-budget.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PreparedReplyTranscriptStart } from "../get-reply-options.types.js";
import type { ThinkLevel } from "../thinking.js";
import type { AgentLifecycleTerminalBackstop } from "./agent-lifecycle-terminal.js";
import type {
  AgentTurnCompaction,
  AgentTurnInternalResult,
  AgentTurnParams,
  CompletedAgentAuthSelection,
  EmbeddedAgentRunResult,
  RuntimeFallbackAttempt,
} from "./agent-runner-execution.types.js";
import type { createAgentTurnPresentation } from "./agent-runner-presentation.js";
import type { AgentTurnTimingTracker } from "./agent-runner-turn-timing.js";
import type { CurrentTurnImages } from "./current-turn-images.js";
import type { FollowupRun } from "./queue.js";
import type { DirectBlockDelivery } from "./reply-delivery.js";

type AgentFallbackRunContext = {
  preparedRunAdmission: PreparedAgentRunAdmission;
  turn: AgentTurnParams;
  runtimeConfig: OpenClawConfig;
  runId: string;
  runAbortSignal?: AbortSignal;
  currentTurnImages: CurrentTurnImages;
  presentation: ReturnType<typeof createAgentTurnPresentation>;
  timing: AgentTurnTimingTracker;
};

/** Inputs prepared once per fallback candidate and consumed by either runtime adapter. */
export type AgentFallbackCandidateCommonParams = RunEntryCandidateOptions &
  AgentFallbackRunContext & {
    messageActionTurnCapability?: string;
    candidateRun: FollowupRun["run"];
    provider: string;
    model: string;
    candidateThinkLevel?: ThinkLevel;
    candidateFastMode: Pick<RunEmbeddedAgentParams, "fastMode" | "fastModeAutoOnSeconds">;
    runLane: RunEmbeddedAgentParams["lane"];
    suppressQueuedUserPersistenceForCandidate: boolean;
    userTurnTranscriptRecorder: RunEmbeddedAgentParams["userTurnTranscriptRecorder"];
    onCompletedSourceReplyDelivered: NonNullable<
      RunEmbeddedAgentParams["onCompletedSourceReplyDelivered"]
    >;
    notifyUserMessagePersisted: () => void;
    fastModeStartedAtMs: number;
    fastModeAutoProgressState: FastModeAutoProgressState;
    bootstrapContextRunKind: BootstrapContextRunKind;
    bootstrapPromptWarningSignaturesSeen: string[];
    signalExecutionPhaseForTyping: NonNullable<RunEmbeddedAgentParams["onExecutionPhase"]>;
    prepareAgentRunStart: () => void | Promise<void>;
    notifyAgentRunStart: (transcriptStart?: PreparedReplyTranscriptStart | null) => void;
    preserveProgressCallbackStartOrder: boolean;
    onLifecycleBackstop: (backstop: AgentLifecycleTerminalBackstop) => void;
    deferredLifecycle: DeferredEmbeddedRunLifecycleManager;
  };

export type AgentFallbackCycleState = {
  /** Canonical current-source message-tool delivery completed during this logical turn. */
  completedSourceReplyDelivered?: boolean;
  maintenanceAuthProfile?: CompletedAgentAuthSelection;
  compactionRequestBudget?: CompactionRequestBudget;
  deferredLifecycle: DeferredEmbeddedRunLifecycleManager;
  lifecycleGeneration: string;
  /** Turn admission time; terminal backstops must not stamp failure time as the start. */
  turnStartedAtMs: number;
  compaction: AgentTurnCompaction;
  /** Failure attribution only; model start does not prove current token freshness. */
  postCompactionModelAttempted: boolean;
  attemptedRuntimeProvider: string;
  attemptedRuntimeModel: string;
  bootstrapPromptWarningSignaturesSeen: string[];
  pendingLifecycleTerminal?: {
    provider: string;
    model: string;
    backstop: AgentLifecycleTerminalBackstop;
  };
};

type CompletedFallbackCycle = {
  kind: "completed";
  runResult: EmbeddedAgentRunResult;
  fallbackProvider: string;
  fallbackModel: string;
  fallbackExhausted: boolean;
  fallbackAttempts: RuntimeFallbackAttempt[];
  terminalRunFailed: boolean;
};

export type AgentFallbackCycleResult =
  | CompletedFallbackCycle
  | Extract<AgentTurnInternalResult, { kind: "final" | "aborted" }>;

type AgentFallbackModelPatch = {
  captureFallbackFailure: (attempts: RuntimeFallbackAttempt[]) => boolean | undefined;
  captureFailure: (error: unknown) => void;
};

export type AgentFallbackCycleParams = AgentFallbackRunContext & {
  effectiveRun: FollowupRun["run"];
  liveModelSwitchRuntimeEntry?: Pick<
    SessionEntry,
    "agentHarnessId" | "agentRuntimeOverride" | "modelSelectionLocked" | "pluginOwnerId"
  >;
  state: AgentFallbackCycleState;
  directBlockDeliveries: DirectBlockDelivery[];
  createAgentRunStartCallbacks: () => Pick<
    AgentFallbackCandidateCommonParams,
    "prepareAgentRunStart" | "notifyAgentRunStart" | "signalExecutionPhaseForTyping"
  > & { close: () => void };
  notifyUserAboutCompaction: boolean;
  modelPatch: AgentFallbackModelPatch;
  shouldSurfaceToControlUi: boolean;
  commitTerminalOutcome: () => void;
  clearRecoveredAutoFallbackPrimaryProbe: (candidate: {
    provider: string;
    model: string;
  }) => Promise<void>;
};
