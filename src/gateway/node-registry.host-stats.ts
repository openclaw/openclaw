import { AsyncLocalStorage } from "node:async_hooks";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { monotonicNow } from "../shared/monotonic-time.js";
import type { NodeHostStats } from "../shared/node-host-stats.js";
import type { NodeSession } from "./node-session.types.js";

export type PersistNodeHostStats = (params: {
  nodeId: string;
  hostStats: NodeHostStats;
  expectedPairingGeneration: { nodeId: string; key: string };
}) => Promise<boolean>;

const HOST_STATS_CHECKPOINT_MS = 5 * 60_000;
type HostStatsCheckpoint = {
  saved?: NodeHostStats;
  pending?: Promise<void>;
  failed: boolean;
  /** Monotonic-clock deadline (performance.now() domain) for the next persist. */
  savedAtMonotonicMs?: number;
  /** Latest received sample and the monotonic instant its next checkpoint is due. */
  sample?: { stats: NodeHostStats; nextCheckpointAtMs: number };
};
const log = createSubsystemLogger("gateway/nodes");

export class NodeHostStatsCheckpoints {
  private checkpoints = new Map<NodeSession, HostStatsCheckpoint>();
  private pending = new Set<Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closing: Promise<void> | undefined;
  private runInOwnerContext = AsyncLocalStorage.snapshot();

  constructor(private readonly options: { persistHostStats?: PersistNodeHostStats }) {}

  record(node: NodeSession): void {
    if (this.options.persistHostStats && node.pairingGeneration && !this.closing) {
      let checkpoint = this.checkpoints.get(node);
      if (!checkpoint) {
        checkpoint = { failed: false };
        this.checkpoints.set(node, checkpoint);
      }
      checkpoint.failed = false;
      this.captureSampleDeadline(node, checkpoint);
      if (!checkpoint.pending && !checkpoint.saved) {
        this.persist(node, checkpoint);
      }
      this.schedule();
    }
  }

  /**
   * Pairs a received sample's persisted receipt with the monotonic clock while the two
   * are still in sync. Persisting later (the timer writes a buffered sample) would
   * otherwise fold any clock step since the receipt into the following budget.
   */
  private captureSampleDeadline(node: NodeSession, checkpoint: HostStatsCheckpoint): void {
    const sample = node.hostStats;
    if (!sample || sample === checkpoint.saved) {
      return;
    }
    checkpoint.sample = {
      stats: sample,
      nextCheckpointAtMs:
        monotonicNow() + Math.max(0, sample.updatedAtMs + HOST_STATS_CHECKPOINT_MS - Date.now()),
    };
  }

  private persist(node: NodeSession, checkpoint: HostStatsCheckpoint): void {
    const hostStats = node.hostStats;
    const persist = this.options.persistHostStats;
    const pairingGeneration = node.pairingGeneration;
    if (!hostStats || !persist || !pairingGeneration || checkpoint.pending) {
      return;
    }
    // The budget for the sample being written was captured at its receipt; reusing it
    // keeps the write itself from re-reading the wall clock. A sample without a captured
    // receipt is checkpointed immediately rather than deriving a deadline now.
    const savedAtMonotonicMs =
      checkpoint.sample?.stats === hostStats ? checkpoint.sample.nextCheckpointAtMs : undefined;
    // Enter the existing pairing FIFO synchronously in the Gateway owner's context.
    const pending = this.runInOwnerContext(async () => {
      try {
        if (
          await persist({
            nodeId: node.nodeId,
            hostStats,
            expectedPairingGeneration: { nodeId: node.nodeId, key: pairingGeneration },
          })
        ) {
          checkpoint.saved = hostStats;
          checkpoint.savedAtMonotonicMs = savedAtMonotonicMs;
        } else {
          checkpoint.failed = true;
        }
      } catch (error) {
        checkpoint.failed = true;
        log.warn(
          `failed to persist node host stats for ${node.nodeId}: ${formatErrorMessage(error)}`,
        );
      }
    }).then(() => {
      checkpoint.pending = undefined;
      this.pending.delete(pending);
      this.schedule();
    });
    checkpoint.pending = pending;
    this.pending.add(pending);
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closing) {
      return;
    }
    let deadline = Infinity;
    for (const [node, checkpoint] of this.checkpoints) {
      if (!checkpoint.pending && !checkpoint.failed && node.hostStats !== checkpoint.saved) {
        // The budget was translated once when the saved receipt was written; reusing it
        // keeps repeated schedules (another node reporting, an early timer) from
        // re-reading the wall clock and pushing the deadline out. A checkpoint without a
        // saved receipt yet has no budget, so it is due immediately.
        deadline = Math.min(deadline, checkpoint.savedAtMonotonicMs ?? 0);
      }
    }
    if (deadline === Infinity) {
      return;
    }
    // Timers must not retain the heartbeat request's admission/source scope.
    this.runInOwnerContext(() => {
      this.timer = setTimeout(
        () => {
          for (const [node, checkpoint] of this.checkpoints) {
            if (
              !checkpoint.pending &&
              !checkpoint.failed &&
              node.hostStats !== checkpoint.saved &&
              (checkpoint.savedAtMonotonicMs ?? 0) <= monotonicNow()
            ) {
              this.persist(node, checkpoint);
            }
          }
          this.schedule();
        },
        Math.max(0, deadline - monotonicNow()),
      );
      this.timer.unref();
    });
  }

  forget(node: NodeSession): void {
    this.checkpoints.delete(node);
    this.schedule();
  }

  close(): Promise<void> {
    clearTimeout(this.timer);
    return (this.closing ??= (async () => {
      await Promise.all(this.pending);
      for (const [node, checkpoint] of this.checkpoints) {
        if (node.hostStats !== checkpoint.saved) {
          this.persist(node, checkpoint);
        }
      }
      await Promise.all(this.pending);
      this.checkpoints.clear();
    })());
  }
}
