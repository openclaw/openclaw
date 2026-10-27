import { AsyncLocalStorage } from "node:async_hooks";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { NodeHostStats } from "../shared/node-host-stats.js";
import type { NodeSession } from "./node-session.types.js";

export type PersistNodeHostStats = (params: {
  nodeId: string;
  hostStats: NodeHostStats;
  expectedPairingGeneration: { nodeId: string; key: string };
}) => Promise<boolean>;

const HOST_STATS_CHECKPOINT_MS = 5 * 60_000;
type HostStatsCheckpoint = { saved?: NodeHostStats; pending?: Promise<void>; failed: boolean };
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
      if (!checkpoint.pending && !checkpoint.saved) {
        this.persist(node, checkpoint);
      }
      this.schedule();
    }
  }

  private persist(node: NodeSession, checkpoint: HostStatsCheckpoint): void {
    const hostStats = node.hostStats;
    const persist = this.options.persistHostStats;
    const pairingGeneration = node.pairingGeneration;
    if (!hostStats || !persist || !pairingGeneration || checkpoint.pending) {
      return;
    }
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
        deadline = Math.min(
          deadline,
          (checkpoint.saved?.updatedAtMs ?? 0) + HOST_STATS_CHECKPOINT_MS,
        );
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
              (checkpoint.saved?.updatedAtMs ?? 0) + HOST_STATS_CHECKPOINT_MS <= Date.now()
            ) {
              this.persist(node, checkpoint);
            }
          }
          this.schedule();
        },
        Math.max(0, deadline - Date.now()),
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
