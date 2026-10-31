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

type HostStatsCheckpoint = {
  saved?: NodeHostStats;
  pending?: Promise<void>;
};
const log = createSubsystemLogger("gateway/nodes");

export class NodeHostStatsCheckpoints {
  private checkpoints = new Map<NodeSession, HostStatsCheckpoint>();
  private pending = new Set<Promise<void>>();
  private closing: Promise<void> | undefined;
  private runInOwnerContext = AsyncLocalStorage.snapshot();

  constructor(private readonly options: { persistHostStats?: PersistNodeHostStats }) {}

  record(node: NodeSession): void {
    if (this.options.persistHostStats && node.pairingGeneration && !this.closing) {
      let checkpoint = this.checkpoints.get(node);
      if (!checkpoint) {
        checkpoint = {};
        this.checkpoints.set(node, checkpoint);
      }
      if (!checkpoint.pending && !checkpoint.saved) {
        this.persist(node, checkpoint);
      }
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
        }
      } catch (error) {
        log.warn(
          `failed to persist node host stats for ${node.nodeId}: ${formatErrorMessage(error)}`,
        );
      }
    }).then(() => {
      checkpoint.pending = undefined;
      this.pending.delete(pending);
    });
    checkpoint.pending = pending;
    this.pending.add(pending);
  }

  forget(node: NodeSession): void {
    this.checkpoints.delete(node);
  }

  close(): Promise<void> {
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
