import { AsyncLocalStorage } from "node:async_hooks";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { StoreWriterQueue } from "../shared/store-writer-queue.js";
import type { AgentWorkAdmissionIdentity } from "./session-agent-work-admission.js";
import type {
  HandoffSessionWorkAdmission,
  SessionWorkAdmissionLease,
} from "./session-work-admission-handoff.js";
import type { SessionWorkRun } from "./session-work-admission-queries.js";

export type SessionWorkAdmission = HandoffSessionWorkAdmission & {
  agent?: AgentWorkAdmissionIdentity;
  run?: SessionWorkRun;
  phase: "pending" | "acquired";
  owner?: symbol;
  released: Promise<void>;
};

export type SessionLifecycleMutationOwner = {
  identities: readonly string[];
  kind?: SessionLifecycleMutationKind;
};

type SessionLifecycleAdmissionState = {
  lifecycleQueues: Map<string, StoreWriterQueue>;
  mutationQueues: Map<string, StoreWriterQueue>;
  activeAdmissions: Map<string, Set<SessionWorkAdmission>>;
  workReleaseListeners: Map<string, Set<() => void>>;
  activeMutationRuns: Set<SessionLifecycleMutationOwner>;
  idleWaiters: Map<string, Set<() => void>>;
  currentAdmissions: AsyncLocalStorage<ReadonlySet<SessionWorkAdmission>>;
};

export type SessionLifecycleMutationKind = "compaction";

// Runtime chunks can load separate module instances while still coordinating
// the same sessions. One shared state keeps every lock and admission visible.
export const SESSION_LIFECYCLE_ADMISSION_STATE = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionLifecycleAdmissionState"),
  (): SessionLifecycleAdmissionState => ({
    lifecycleQueues: new Map(),
    mutationQueues: new Map(),
    activeAdmissions: new Map(),
    workReleaseListeners: new Map(),
    activeMutationRuns: new Set(),
    idleWaiters: new Map(),
    currentAdmissions: new AsyncLocalStorage(),
  }),
);

/** Exact live lease running in this async context, not another owner of the session. */
export function isCurrentSessionWorkAdmission(lease: SessionWorkAdmissionLease): boolean {
  return (
    lease.isActive() &&
    [...(SESSION_LIFECYCLE_ADMISSION_STATE.currentAdmissions.getStore() ?? [])].some(
      (admission) => admission.released === lease.released && admission.phase === "acquired",
    )
  );
}
