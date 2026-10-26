import type { AdmittedRunContext } from "../../agents/admitted-run-context.js";
import type { ExecutionIdentityAdmissionFacts } from "../../audit/execution-identity-admission.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { SessionEventTarget } from "../../auto-reply/reply/session-event-contract.js";
import type { CronConfig } from "../../config/types.cron.js";
import type { GatewayScheduler, GatewaySchedulerScope } from "../../infra/gateway-scheduler.js";
import { LEGACY_IMPLICIT_AGENT_ID } from "../../routing/session-key.js";
import type { ReplyOperationObservation } from "../../sessions/reply-operation-state.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { CronAgentAvailability } from "../agent-availability.js";
import type { CronCompletionDeliveryFence } from "../delivery-attempt-fence.js";
import type { PluginCommandScheduleHost } from "../plugin-command-schedule.types.js";
import { toPublicCronJob } from "../public-job.js";
import type { ScheduledOccurrence } from "../scheduled-occurrence.js";
import type { CronScheduledToolPolicy } from "../scheduled-tool-policy.js";
import type { CronJobScratchState } from "../scratch-contract.js";
import { cronStoreKey } from "../store/key.js";
import { resolveCronStoreKeyAsync, resolveDefaultCronStorePath } from "../store/paths.js";
import type { QuarantinedCronConfigJob } from "../types-shared.js";
import type {
  CronWebhookDeliveryOutcome,
  CronTriggerEvaluationResult,
  CronAgentExecutionPhaseUpdate,
  CronAgentExecutionStarted,
  CronFailureNotificationDelivery,
  CronFailureNotificationDetail,
  CronEvent,
  CronJob,
  CronNextCheckProposal,
  CronJobCreate,
  CronJobPatch,
  CronRunDeliveryResult,
  CronMessageChannel,
  CronRunOutcome,
  CronRunTelemetry,
  CronStoredJob,
  CronStoreFile,
} from "../types.js";
import type { CronAddOptions } from "./job-options.types.js";
import type { CronJobsSortBy, CronSortDir } from "./list-page-types.js";
import type {
  CronNotificationIntent,
  CronNotificationJob,
  CronNotificationRouting,
  ResolvedFailureAlert,
} from "./notification-intents.js";

export type { CronAddOptions } from "./job-options.types.js";

/** Transient internal context delivered beside, but never projected into, a CronEvent. */
type CronEventContext = {
  failureNotificationDetail?: CronFailureNotificationDetail;
};

export function cronFailureNotificationEventContext(
  failureNotificationDetail?: CronFailureNotificationDetail,
): CronEventContext | undefined {
  return failureNotificationDetail ? { failureNotificationDetail } : undefined;
}

export type Logger = {
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

type CronSystemEventEnqueueResult =
  | boolean
  | void
  | {
      accepted?: boolean;
      remove?: () => boolean | void;
      adopted?: Promise<boolean>;
    };

/** Notifications queued by cron mutations until their state is durable. */
export type DeferredCronNotifications = CronNotificationIntent[];

/** One captured notice selection and scratch read retained through its scheduled turn. */
export type CronSessionRunPreparation = {
  agentId: string;
  sessionKey: string;
  notices: Awaited<
    ReturnType<typeof import("../../infra/system-events.js").prepareAutomationSystemEvents>
  >;
  scratch?: CronJobScratchState;
};

export type CronIdleAdmissionWait = (
  ownSessionKey?: string,
  signal?: AbortSignal,
  ownReplyOperation?: ReplyOperationObservation,
) => Promise<void>;
export type CronIdleAdmissionSource = { signal: AbortSignal; assertCurrent: () => void };

export type CronServiceDeps = {
  /** Shares the Gateway's state-directory selection across admission checks. */
  env?: NodeJS.ProcessEnv;
  nowMs?: () => number;
  scheduler: GatewayScheduler;
  log: Logger;
  storePath: string;
  cronEnabled: boolean;
  /** CronConfig for session retention settings. */
  cronConfig?: CronConfig;
  /** Host-owned, read-only diagnostics before startup recovery can dispatch loaded jobs. */
  describeJobLoadWarning?: (job: CronStoredJob) => string | undefined;
  /** Disallow automation jobs that run commands or scripts on the host. */
  hostExecutionDisabled?: boolean;
  resolveUserTimezone?: () => string | undefined;
  /** Resident admission facts; normal reply admission owns recovery barriers. */
  isExecutionIdle?: (
    job: CronJob,
    ownSessionKey?: string,
    ownReplyOperation?: ReplyOperationObservation,
  ) => boolean;
  /**
   * Loaded plugin instances that can serve requester-command schedules. The claim re-arms a
   * restartable schedule from an earlier Gateway process onto a matching one; without it, such
   * schedules retire at their next occurrence.
   */
  resolvePluginCommandScheduleHosts?: () => PluginCommandScheduleHost[];
  /** List enabled, configured channel ids without exposing channel machinery to cron core. */
  listConfiguredChannels?: () => readonly string[] | Promise<readonly string[]>;
  /**
   * Admits one occurrence before any trigger or payload work. When unset (local
   * harnesses), every run's context is a `fail` result.
   */
  admitScheduledOccurrence?: (params: { job: CronStoredJob }) => Promise<ScheduledOccurrence>;
  evaluateCronTrigger?: (params: {
    occurrence: ScheduledOccurrence;
    deliveryAttemptFence: CronCompletionDeliveryFence | null;
    job: CronStoredJob;
    script: string;
    state: unknown;
    streamBatch?: string;
    abortSignal?: AbortSignal;
    executionIdentity?: CronExecutionIdentityAdmission;
  }) => Promise<CronTriggerEvaluationResult>;
  /** Default agent id for jobs without an agent id. */
  defaultAgentId?: string;
  /** Resolve the current default when runtime config can change after startup. */
  resolveDefaultAgentId?: () => string | undefined;
  /** Resolve configured or persisted owners whose session stores need periodic cleanup. */
  resolveSessionStoreAgentIds?: () => string[] | Promise<string[]>;
  /** Revalidate resident policy using the worker's deletion facts. */
  isAgentAvailable?: CronAgentAvailability;
  resolveSessionStorePath?: (agentId?: string) => string;
  /** Path to the session store (sessions.json) for reaper use. */
  sessionStorePath?: string;
  /**
   * Delay in ms between missed job executions on startup.
   * Prevents overwhelming the gateway when many jobs are overdue.
   * See: https://github.com/openclaw/openclaw/issues/18892
   */
  missedJobStaggerMs?: number;
  /**
   * Maximum number of missed jobs to run immediately on startup.
   * Additional missed jobs will be rescheduled to fire gradually.
   * See: https://github.com/openclaw/openclaw/issues/18892
   */
  maxMissedJobsPerRestart?: number;
  /**
   * Delay before replaying missed agent-turn jobs found during gateway startup.
   * Keeps model/tool bootstrap work out of the channel connect window.
   */
  startupDeferredMissedAgentJobDelayMs?: number;
  enqueueSystemEvent: (
    text: string,
    opts?: {
      agentId?: string;
      sessionKey?: string;
      contextKey?: string;
      deliveryContext?: DeliveryContext;
    },
  ) => CronSystemEventEnqueueResult;
  /**
   * Resolve the channel-correct origin delivery context for a session key (the
   * value the channel's send expects, e.g. Telegram message_thread_id), sourced
   * from the session store entry the wake targets. Used to carry the bound
   * thread/topic onto manual wake system events. Optional: when unset, wakes
   * route as before. Returning `undefined` is also a no-op (default routing).
   */
  resolveOriginDeliveryContext?: (params: {
    sessionKey?: string;
    agentId?: string;
  }) => DeliveryContext | undefined | Promise<DeliveryContext | undefined>;
  /** Binds the Gateway for complete scheduled operations, including admission and settlement. */
  runSchedulerOwned?: <T>(run: () => Promise<T>) => Promise<T>;
  /** Producer events enter ordinary session admission even when scheduling is disabled. */
  enqueueSessionEvent?: (
    text: string,
    opts?: {
      agentId?: string;
      sessionKey?: string;
      contextKey?: string;
      deliveryContext?: DeliveryContext;
      expectedTarget?: SessionEventTarget;
      createIfMissing?: true;
      assertAcceptanceCurrent?: () => void;
    },
  ) => void | Promise<{ ok: true } | { ok: false; error: string }>;
  deferSessionEvent?: (
    text: string,
    job: CronJob,
    expectedTarget: SessionEventTarget | undefined,
    assertCurrent: () => void,
    notBeforeRunAtMs: number,
    coalescing?: {
      revision: string;
      assertCurrent: () => void;
      onOutcome: (outcome: "queued" | "coalesced") => void;
    },
    createIfMissing?: true,
  ) => void | Promise<void>;
  captureSessionEventTarget?: (job: CronJob) => Promise<SessionEventTarget | undefined>;
  resolveSessionEventTarget?: (opts?: { agentId?: string; sessionKey?: string }) => {
    agentId?: string;
    sessionKey?: string;
  };
  runIsolatedAgentJob: (params: {
    occurrence: ScheduledOccurrence;
    waitForIdle?: CronIdleAdmissionWait;
    deliveryAttemptFence: CronCompletionDeliveryFence | null;
    job: CronJob;
    admissionSource?: AdmittedRunContext["admissionSource"];
    message: string;
    abortSignal?: AbortSignal;
    onExecutionStarted?: (info?: CronAgentExecutionStarted) => void;
    onExecutionPhase?: (info: CronAgentExecutionPhaseUpdate) => void;
    onLaneWait?: (info?: { waiting?: boolean }) => void;
    executionIdentity?: CronExecutionIdentityAdmission;
  }) => Promise<
    CronRunOutcome &
      CronRunTelemetry &
      CronRunDeliveryResult & {
        /** Last non-empty agent text output (not truncated). */
        outputText?: string;
        nextCheck?: CronNextCheckProposal;
      }
  >;
  /** Shared-conversation work settles through the session controller's ordinary turn owner. */
  runSessionEvent?: (params: {
    occurrence: ScheduledOccurrence;
    waitForIdle?: CronIdleAdmissionWait;
    sessionPreparation?: CronSessionRunPreparation;
    deliveryContext?: DeliveryContext;
    admissionSource: NonNullable<AdmittedRunContext["admissionSource"]>;
    deliveryAttemptFence: CronCompletionDeliveryFence | null;
    onExecutionStarted?: (info?: CronAgentExecutionStarted) => void;
    onExecutionPhase?: (info: CronAgentExecutionPhaseUpdate) => void;
    onLaneWait?: (info?: { waiting?: boolean }) => void;
    executionIdentity?: CronExecutionIdentityAdmission;
    job: CronStoredJob;
    text: string;
    abortSignal?: AbortSignal;
    prepare?: () => Promise<void>;
    assertCurrent: () => void;
  }) => Promise<
    CronRunOutcome &
      CronRunTelemetry &
      CronRunDeliveryResult & { nextCheck?: CronNextCheckProposal }
  >;
  runCommandJob?: (params: {
    /** Consumed by the occurrence; command runs are not agent runs and mint no context. */
    occurrence: ScheduledOccurrence;
    deliveryAttemptFence: CronCompletionDeliveryFence | null;
    job: CronJob;
    abortSignal?: AbortSignal;
  }) => Promise<CronRunOutcome & CronRunDeliveryResult>;
  runScriptJob?: (params: {
    occurrence: ScheduledOccurrence;
    deliveryAttemptFence: CronCompletionDeliveryFence | null;
    job: CronStoredJob;
    streamBatch?: string;
    abortSignal?: AbortSignal;
    executionIdentity?: CronExecutionIdentityAdmission;
  }) => Promise<
    CronRunOutcome &
      CronRunDeliveryResult & {
        notify?: string;
        wake?: "now" | "next-heartbeat";
        stateChanged?: boolean;
        state?: unknown;
        nextCheck?: CronNextCheckProposal;
      }
  >;
  /** Deliver a primary cron webhook before the run outcome is finalized. */
  sendCronWebhook?: (params: {
    job: CronJob;
    event: CronEvent;
    abortSignal: AbortSignal;
    onDeliveryState: (outcome: CronWebhookDeliveryOutcome) => void;
    assertCurrent?: () => void;
  }) => Promise<CronWebhookDeliveryOutcome>;
  cleanupTimedOutAgentRun?: (params: {
    job: CronJob;
    timeoutMs: number;
    execution?: CronAgentExecutionStarted;
  }) => Promise<void>;
  onIsolatedAgentSetupTimeout?: (params: {
    job: CronJob;
    error: string;
    timeoutMs: number;
  }) => void | Promise<void>;
  sendCronFailureAlert?: (params: {
    job: CronNotificationJob;
    routing: CronNotificationRouting;
    payload: ReplyPayload;
    runAtMs?: number;
    channel: CronMessageChannel;
    to?: string;
    mode?: "announce" | "webhook";
    accountId?: string;
    threadId?: string | number;
    inheritSessionThread?: false;
    /** Persists the transport-owned terminal fact before Gateway work admission releases. */
    onDeliverySettled: (outcome: CronFailureNotificationDelivery) => Promise<void>;
  }) => Promise<void>;
  /** Uses the same resolved timeout as the owner-conversation agent turn. */
  failureRepairTimeoutMs?: number;
  /**
   * Runs one ordinary turn in the conversation that owns a failing job, resolving
   * only after settlement; its authored reply goes to the conversation's own route.
   */
  runCronFailureRepair?: (request: CronFailureRepairRequest) => Promise<void>;
  onEvent?: (evt: CronEvent, context?: CronEventContext) => void;
  onProvisionedJobsReloaded?: () => Promise<void>;
};

/** The scheduler's repair request for one failure incident of an owned job. */
export type CronFailureRepairRequest = {
  jobId: string;
  repairId: string;
  timeoutMs: number;
  agentId?: string;
  sessionKey: string;
  message: string;
};

export type CronExecutionIdentityAdmission = {
  ingress: ExecutionIdentityAdmissionFacts["ingress"];
  invoker?: ExecutionIdentityAdmissionFacts["invoker"];
  onPostAdmission?: (context: AdmittedRunContext) => void | Promise<void>;
};

type CronServiceDepsInternal = Omit<CronServiceDeps, "env" | "nowMs"> & {
  storeKey: string;
  env: NodeJS.ProcessEnv;
  nowMs: () => number;
};

/** Dependencies consumed by job policy before its mutation is committed. */
export type CronJobPolicyContext = {
  deps: Pick<CronServiceDepsInternal, "cronConfig" | "nowMs" | "log" | "failureRepairTimeoutMs">;
  /** Resolved by the host for this exact job while its recovery transaction holds the row. */
  preparedFailureAlert?: { jobId: string; value: ResolvedFailureAlert | null };
};

export type CronServiceState = {
  deps: CronServiceDepsInternal;
  store: CronStoreFile | null;
  /** Worker publications replace the source rows or advance the store revision. */
  readSnapshot?: {
    storeRevision: number;
    source: CronJob[] | undefined;
    status: CronStatusSummary;
    lists: {
      filteredJobs: CronJob[];
      sortBy: CronJobsSortBy;
      sortDir: CronSortDir;
      jobs: CronJob[];
      snapshotRevision: string;
    }[];
    /** Requested rows are detached and frozen once for this list generation. */
    readJobs: WeakMap<CronJob, CronJob>;
  };
  /** Last known durable wake for each persisted job. Map presence distinguishes
   * a durably unscheduled job from one that is not part of durable topology. */
  durableNextRunAtMsByJobId: Map<string, number | undefined>;
  schedulerScope: GatewaySchedulerScope;
  /** Retains stopped generations while an immediate restart admits new work. */
  schedulerDrain: Promise<void>;
  stopped: boolean;
  /** Rotates synchronously on stop so an immediate restart cannot revive old work. */
  lifecycleGeneration: number;
  schedulingPaused: boolean;
  schedulerStarted: boolean;
  activeManualRunJobIds: Set<string>;
  /** Accepted manual runs until their terminal history row is written, keyed by runId. */
  queuedManualRuns: Map<string, Promise<unknown>>;
  manualSetupTimeoutNotified: boolean;
  /** Serializes mutating service operations so store writes and timers stay ordered. */
  op: Promise<unknown>;
  warnedDisabled: boolean;
  /**
   * Persisted job rows with non-canonical storage shape are skipped in memory
   * until the runtime can quarantine and sanitize the active store.
   */
  warnedInvalidPersistedJobKeys: Set<string>;
  pendingQuarantineConfigJobs: QuarantinedCronConfigJob[];
  lastQuarantineFailureWarnKey: string | null;
  storeLoadedAtMs: number | null;
};

export const CRON_HOST_EXECUTION_DISABLED_MESSAGE =
  "Automation jobs that execute on the Gateway host are disabled by OPENCLAW_DISABLE_CRON_HOST_EXECUTION; contact the Gateway deployment administrator to enable them.";

/** Triggers and process-backed schedules can start host work independently of the job payload. */
export function describeCronHostExecutionRestriction(
  job: CronStoredJob,
  hostExecutionDisabled: boolean | undefined,
): string | undefined {
  if (
    hostExecutionDisabled &&
    (job.payload.kind === "command" ||
      job.payload.kind === "script" ||
      job.schedule.kind === "on-exit" ||
      (job.schedule.kind === "stream" && !job.streamSandbox) ||
      job.trigger)
  ) {
    return CRON_HOST_EXECUTION_DISABLED_MESSAGE;
  }
  return undefined;
}

export function assertCronHostExecutionAllowed(state: CronServiceState, job: CronStoredJob): void {
  const reason = describeCronHostExecutionRestriction(job, state.deps.hostExecutionDisabled);
  if (reason) {
    throw new TypeError(reason);
  }
}

export function createCronServiceState(deps: CronServiceDeps): CronServiceState {
  // The public CronService constructor shipped before roster-aware callers.
  // Preserve its implicit owner unless a static or dynamic configured default exists.
  const defaultAgentId =
    deps.defaultAgentId ?? (deps.resolveDefaultAgentId ? undefined : LEGACY_IMPLICIT_AGENT_ID);
  return {
    deps: {
      ...deps,
      env: deps.env ?? process.env,
      storeKey: cronStoreKey(deps.storePath),
      defaultAgentId,
      nowMs: deps.nowMs ?? (() => deps.scheduler.now()),
    },
    store: null,
    durableNextRunAtMsByJobId: new Map<string, number | undefined>(),
    schedulerScope: deps.scheduler.scope(),
    schedulerDrain: Promise.resolve(),
    stopped: false,
    lifecycleGeneration: 0,
    schedulingPaused: false,
    schedulerStarted: false,
    activeManualRunJobIds: new Set<string>(),
    queuedManualRuns: new Map<string, Promise<unknown>>(),
    manualSetupTimeoutNotified: false,
    op: Promise.resolve(),
    warnedDisabled: false,
    warnedInvalidPersistedJobKeys: new Set<string>(),
    pendingQuarantineConfigJobs: [],
    lastQuarantineFailureWarnKey: null,
    storeLoadedAtMs: null,
  };
}

const preparedStoreSelections = new WeakMap<
  CronServiceState,
  {
    admission: ReturnType<typeof captureOpenClawStateWorkerContext>["admission"];
    promise: Promise<void>;
    ready: boolean;
  }
>();

/** Resolve once per admission; warm callers enter their operation queue without yielding. */
export function prepareCronServiceStore(state: CronServiceState): Promise<void> | undefined {
  const context = captureOpenClawStateWorkerContext();
  const previous = preparedStoreSelections.get(state);
  if (previous?.admission === context.admission) {
    return previous.ready ? undefined : previous.promise;
  }
  if (previous) {
    state.store = null;
    state.readSnapshot = undefined;
  }
  const promise = (async () => {
    const env = state.deps.env;
    if (cronStoreKey(state.deps.storePath) === resolveDefaultCronStorePath(env)) {
      await runOpenClawStateWorkerOperation(context, async () => {});
    }
    state.deps.storeKey = await resolveCronStoreKeyAsync(state.deps.storePath, env, context);
  })();
  const selection = { admission: context.admission, promise, ready: false };
  preparedStoreSelections.set(state, selection);
  void promise.then(
    () => {
      selection.ready = true;
    },
    () => {
      if (preparedStoreSelections.get(state)?.promise === promise) {
        preparedStoreSelections.delete(state);
      }
    },
  );
  return promise;
}

/** Dispatches a cron event without letting subscriber errors escape scheduler work. */
export function emit(state: CronServiceState, evt: CronEvent, context?: CronEventContext) {
  try {
    const publicEvent = evt.job ? { ...evt, job: toPublicCronJob(evt.job) } : evt;
    if (context) {
      state.deps.onEvent?.(publicEvent, context);
    } else {
      state.deps.onEvent?.(publicEvent);
    }
  } catch {
    /* ignore */
  }
}

/** Direct-run mode: respect due time, force execution, or run immediately while enabled. */
export type CronRunMode = "due" | "force" | "if-enabled";

export function isImmediateCronRunMode(mode: CronRunMode | undefined): boolean {
  return mode === "force" || mode === "if-enabled";
}

/** Main-session wake strategy used after enqueuing cron text. */
export type CronWakeMode = "now" | "next-heartbeat";

export type CronStatusSummary = {
  enabled: boolean;
  triggersEnabled: boolean;
  /** @deprecated Alias for `sqlitePath`. */
  storePath: string;
  storage: "sqlite";
  /** Resolved path to the shared state SQLite database. */
  sqlitePath: string;
  jobs: number;
  nextWakeAtMs: number | null;
};

export type CronRunResult =
  | { ok: true; ran: true }
  | { ok: true; enqueued: true; runId: string }
  | { ok: true; ran: false; reason: "disabled" }
  | { ok: true; ran: false; reason: "not-due" }
  | { ok: true; ran: false; reason: "already-running" }
  | { ok: true; ran: false; reason: "invalid-spec" }
  | { ok: true; ran: false; reason: "stopped" }
  | { ok: true; ran: false; reason: "ownerless" }
  | { ok: false };

/** Remove result, including deferred base-session cleanup after durable deletion. */
export type CronRemoveResult =
  | {
      ok: true;
      removed: boolean;
      activeRunCancellationRequested?: true;
      sessionCleanup?: "pending";
    }
  | { ok: false; removed: false };

type CronDeclarativeAddResult = CronStoredJob & {
  created: boolean;
  updated?: boolean;
  job: CronStoredJob;
};
export type CronAddResult = CronStoredJob | CronDeclarativeAddResult;
export type CronUpdateResult = CronJob;

export type CronListResult = CronJob[];
export type CronAddInput = CronJobCreate;
export type CronUpdateInput = CronJobPatch;
/** Authenticated caller provenance used only when a tool policy is explicitly adopted. */
export type CronUpdateOptions = Pick<
  CronAddOptions,
  | "operatorSource"
  | "operatorSourceExecutionRevision"
  | "toolsAllowProvenance"
  | "toolsAllowExecTarget"
  | "commitGuard"
  | "captureRuntimeAuthority"
  | "inferenceBinding"
  | "execPolicy"
  | "streamExecApproval"
  | "streamSandbox"
  | "sessionEntryCurrent"
> & {
  /** Parent incarnation recorded by `automations bind`; only fills an absent link. */
  bindSourceConversation?: NonNullable<CronStoredJob["sourceConversation"]>;
  /** Null forbids policy adoption; undefined retains in-process operator defaults. */
  scheduledToolPolicy?: CronScheduledToolPolicy | null;
};

export type CronCommitGuardOptions = {
  /** Synchronous Gateway-owned liveness check repeated at mutation admission and commit. */
  commitGuard?: () => void;
};
export type CronRemoveOptions = CronCommitGuardOptions & {
  systemOwned?: boolean;
  /** The reviewed definition must still match at the store lock and durable commit. */
  expectedConfigRevision?: string;
};
/** Cron-store-locked guard evaluated against the current job before an update applies. */
export type CronUpdatePrecondition = (job: CronJob, nowMs: number) => void | Promise<void>;
