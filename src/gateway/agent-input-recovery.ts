import { racePromiseWithAbortSignal } from "../../packages/retry/src/index.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { AgentRecoveryProgress } from "../state/agent-database-preparation-recovery.js";

/** Gateway projection of recovery custody; each recovery owner retains its full work tail. */
export class GatewayInputRecovery {
  private initialReady = false;
  private readonly initial = createDeferredCore();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(initiallyReady = false) {
    // A failed admission remains observable by future waiters, even if none have arrived yet.
    void this.initial.promise.catch(() => {});
    if (initiallyReady) {
      this.releaseInitial();
    }
  }

  track(progress: Promise<AgentRecoveryProgress>, onChange?: () => void): Promise<void> {
    return progress
      .then((recovery) => {
        for (const [agentId, work] of recovery.pending) {
          const previous = this.pending.get(agentId);
          const wait = Promise.all(previous ? [previous, work] : [work]).then(() => {
            if (this.pending.get(agentId) === wait) {
              this.pending.delete(agentId);
              onChange?.();
            }
          });
          // Failure retains the gate; the recovery owner still reports and settles its work.
          void wait.catch(() => {});
          this.pending.set(agentId, wait);
        }
        return recovery.initial;
      })
      .catch((error: unknown) => {
        this.initial.reject(error);
        throw error;
      });
  }

  releaseInitial(): void {
    this.initialReady = true;
    this.initial.resolve();
  }

  isPending(agentId: string): boolean {
    return !this.initialReady || this.pending.has(agentId);
  }

  pendingAgentIds(): string[] {
    return [...this.pending.keys()].toSorted();
  }

  waitForAgentInputRecovery(
    agentId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> | undefined {
    const wait = this.initialReady
      ? this.pending.get(agentId)
      : this.initial.promise.then(() => this.pending.get(agentId));
    return wait ? racePromiseWithAbortSignal(wait, options.signal) : undefined;
  }
}
