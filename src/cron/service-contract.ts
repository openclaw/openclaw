/** Public cron service interface shared by callers and implementations. */
import type { CronListPageOptions, CronListPageResult } from "./service/list-page-types.js";
import type {
  CronAddInput,
  CronAddOptions,
  CronAddResult,
  CronCommitGuardOptions,
  CronListResult,
  CronRemoveResult,
  CronRunMode,
  CronRunResult,
  CronStatusSummary,
  CronUpdateInput,
  CronUpdateOptions,
  CronUpdatePrecondition,
  CronUpdateResult,
  CronWakeMode,
} from "./service/state.js";
import type { CronDelivery, CronJob, CronPayload } from "./types.js";

type CronWakeResult = { ok: true } | { ok: false; reason?: string };

/** Result shape for direct/queued cron runs. */
export type CronServiceRunResult = CronRunResult;
export type CronServiceRunOptions = {
  /** Canonical result of this exact direct run, after durable settlement. */
  onSettledResult?: (result: {
    status: "ok" | "error" | "skipped";
    error?: string;
    deliveryError?: string;
  }) => void;
  payload?: CronPayload;
  /** Per-occurrence routing; stored delivery policy remains authoritative. */
  delivery?: Partial<
    Pick<CronDelivery, "mode" | "target" | "channel" | "to" | "threadId" | "accountId">
  >;
  /** Internal event-source runs keep their persisted trigger on force execution. */
  evaluateTrigger?: boolean;
  /** Current stream batch exposed to trigger scripts as trigger.streamBatch. */
  streamBatch?: string;
  /** Source schedule identity checked under the cron store lock before admission. */
  streamScheduleKey?: string;
  /** Logical source identity; rejects retired batches under same-schedule ABA. */
  streamSourceIdentity?: string;
  onTriggerDisposition?: (disposition: "fired" | "dropped" | "busy" | "error") => void;
  /** Synchronous caller-authority guard consumed before run reservation. */
  commitGuard?: () => void;
};

/** Public cron service facade used by gateway, plugin SDK, and tests. */
export interface CronServiceContract {
  start(): Promise<void>;
  stop(): void;
  status(): Promise<CronStatusSummary>;
  list(opts?: { includeDisabled?: boolean }): Promise<CronListResult>;
  /** The in-process predicate runs under the store lock and must not mutate borrowed jobs. */
  listPage(
    opts?: CronListPageOptions,
    matchesJob?: (job: CronJob) => boolean,
  ): Promise<CronListPageResult>;
  add(input: CronAddInput, opts?: CronAddOptions): Promise<CronAddResult>;
  update(id: string, patch: CronUpdateInput, opts?: CronUpdateOptions): Promise<CronUpdateResult>;
  updateWithPrecondition(
    id: string,
    patch: CronUpdateInput,
    precondition: CronUpdatePrecondition,
    opts?: CronUpdateOptions,
  ): Promise<CronUpdateResult>;
  remove(
    id: string,
    opts?: { systemOwned?: boolean } & CronCommitGuardOptions,
  ): Promise<CronRemoveResult>;
  run(id: string, mode?: CronRunMode, opts?: CronServiceRunOptions): Promise<CronServiceRunResult>;
  enqueueRun(
    id: string,
    mode?: CronRunMode,
    opts?: CronCommitGuardOptions,
  ): Promise<CronServiceRunResult>;
  getJob(id: string): CronJob | undefined;
  readJob(id: string): Promise<CronJob | undefined>;
  getDefaultAgentId(): string | undefined;
  wake(opts: {
    expectedTarget?: import("../auto-reply/reply/session-event-contract.js").SessionEventTarget;
    /** Revalidates the requester immediately before wake admission. */
    commitGuard?: () => void;
    mode: CronWakeMode;
    text: string;
    sessionKey?: string;
    agentId?: string;
  }): CronWakeResult | Promise<CronWakeResult>;
}
