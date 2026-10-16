import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionPlacementDiskSpace } from "../../../packages/gateway-protocol/src/schema/session-placement.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { emitSessionLifecycleEvent } from "../../sessions/session-lifecycle-events.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { StaleWorkerBuildError } from "./admission.js";
import type {
  WorkerPlacementDiskSpaceReader,
  WorkerPlacementRunnerAvailabilityReader,
} from "./placement-projector.js";
import type {
  WorkerSessionPlacementRecord,
  WorkerSessionPlacementStore,
} from "./placement-store.js";
import type { WorkerEnvironmentService } from "./service.js";

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const DISK_SPACE_PROBE_CONCURRENCY = 8;
const DISK_SPACE_PROBE_TIMEOUT_MS = 30_000;
const IDLE_DISK_SPACE_REFRESH_MS = 15 * 60_000;
const DISK_SPACE_RETRY_MS = 60_000;

const REMOTE_DISK_SPACE_PROBE_JS = String.raw`
const fs = require("node:fs");
fs.statfs(process.argv[1], { bigint: true }, (error, stats) => {
  if (error) throw error;
  process.stdout.write(JSON.stringify({
    availableBytes: String(stats.bavail * stats.bsize),
    totalBytes: String(stats.blocks * stats.bsize),
  }));
});
`.trim();

type ActivePlacement = Extract<WorkerSessionPlacementRecord, { state: "active" }>;

type DiskSpaceObservation = ActivePlacement & {
  snapshot: SessionPlacementDiskSpace;
  runnerVersion: number;
};

function hasExactBinding(
  observation: ActivePlacement,
  placement: WorkerSessionPlacementRecord | undefined,
): placement is ActivePlacement {
  return (
    placement?.state === "active" &&
    placement.sessionId === observation.sessionId &&
    placement.generation === observation.generation &&
    placement.environmentId === observation.environmentId &&
    placement.activeOwnerEpoch === observation.activeOwnerEpoch
  );
}

function parseSafeByteCount(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new Error(`Worker disk-space check returned an invalid ${field}`);
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Worker disk-space check ${field} exceeds the protocol limit`);
  }
  return Number(parsed);
}

function classifyDiskSpace(availableBytes: number, totalBytes: number) {
  const available = BigInt(availableBytes);
  const total = BigInt(totalBytes);
  const used = total - available;
  if (
    availableBytes < 100 * MIB ||
    (total > 0n && used * 100n >= total * 98n && availableBytes < GIB)
  ) {
    return "critical" as const;
  }
  if (
    availableBytes < 500 * MIB ||
    (total > 0n && used * 100n >= total * 95n && availableBytes < 5 * GIB)
  ) {
    return "warning" as const;
  }
  return "ok" as const;
}

function parseDiskSpaceProbe(stdout: string, observedAtMs: number): SessionPlacementDiskSpace {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Worker disk-space check returned invalid JSON");
  }
  if (!isRecord(value)) {
    throw new Error("Worker disk-space check returned an invalid result");
  }
  const availableBytes = parseSafeByteCount(value.availableBytes, "available byte count");
  const totalBytes = parseSafeByteCount(value.totalBytes, "total byte count");
  if (availableBytes > totalBytes) {
    throw new Error("Worker disk-space check returned more available bytes than total bytes");
  }
  return {
    status: classifyDiskSpace(availableBytes, totalBytes),
    availableBytes,
    totalBytes,
    observedAtMs,
  };
}

export function createWorkerPlacementDiskSpaceMonitor(params: {
  placements: Pick<WorkerSessionPlacementStore, "prepareMaintenancePlacements">;
  environments: Pick<WorkerEnvironmentService, "startTunnel">;
  runnerAvailability: Pick<WorkerPlacementRunnerAvailabilityReader, "read" | "version">;
  warn: (message: string) => void;
  now?: () => number;
}) {
  const observations = new Map<string, DiskSpaceObservation>();
  const staleBindings = new Map<string, ActivePlacement>();
  const now = params.now ?? Date.now;
  let observationVersion = 0;
  let dirty = true;
  let nextSweepAtMs = 0;
  let lastRunnerVersion = -1;

  const read: WorkerPlacementDiskSpaceReader["read"] = (placement) => {
    const observation = observations.get(placement.sessionId);
    return observation && hasExactBinding(observation, placement)
      ? observation.snapshot
      : undefined;
  };

  const probe = async (placement: ActivePlacement, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    // A stale worker build cannot recover until its placement binding changes.
    const stale = staleBindings.get(placement.sessionId);
    if (stale && hasExactBinding(stale, placement)) {
      return;
    }
    if (params.runnerAvailability.read(placement)?.status === "offline") {
      return;
    }
    const runnerVersion = params.runnerAvailability.version();
    const previousObservation = observations.get(placement.sessionId);
    if (
      previousObservation &&
      hasExactBinding(previousObservation, placement) &&
      previousObservation.updatedAtMs === placement.updatedAtMs &&
      previousObservation.runnerVersion === runnerVersion &&
      now() - previousObservation.snapshot.observedAtMs < IDLE_DISK_SPACE_REFRESH_MS
    ) {
      return;
    }
    const tunnel = await params.environments.startTunnel({
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
      authorize: () => signal?.throwIfAborted(),
    });
    signal?.throwIfAborted();
    const result = await tunnel.runWorkspaceCommand({
      signal,
      transportRetry: "idempotent",
      argv: ["node", "-e", REMOTE_DISK_SPACE_PROBE_JS, placement.remoteWorkspaceDir],
      timeoutMs: DISK_SPACE_PROBE_TIMEOUT_MS,
    });
    signal?.throwIfAborted();
    if (result.termination !== "exit" || result.code !== 0) {
      throw new Error("Worker disk-space check command failed");
    }
    const snapshot = parseDiskSpaceProbe(
      result.stdout,
      Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(now()))),
    );
    const candidate = { ...placement, snapshot, runnerVersion } satisfies DiskSpaceObservation;
    // Late samples remain tagged with their original binding; read() hides them after a move.
    const previous = read(placement);
    observations.set(placement.sessionId, candidate);
    if (
      !previous ||
      previous.availableBytes !== snapshot.availableBytes ||
      previous.totalBytes !== snapshot.totalBytes ||
      previous.observedAtMs !== snapshot.observedAtMs
    ) {
      observationVersion += 1;
    }
    if (previous?.status !== snapshot.status && (previous || snapshot.status !== "ok")) {
      emitSessionLifecycleEvent({
        sessionKey: placement.sessionKey,
        agentId: placement.agentId,
        reason: "worker-disk-space",
      });
    }
  };

  const sweep = async (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) {
      return;
    }
    if (
      !dirty &&
      now() < nextSweepAtMs &&
      lastRunnerVersion === params.runnerAvailability.version()
    ) {
      return;
    }
    // Receipts during the awaited inventory/probes must survive this pass.
    dirty = false;
    lastRunnerVersion = params.runnerAvailability.version();
    nextSweepAtMs = now() + DISK_SPACE_RETRY_MS;
    const inventory = await params.placements.prepareMaintenancePlacements();
    let active: ActivePlacement[];
    try {
      active = inventory.placements.filter(
        (placement): placement is ActivePlacement => placement.state === "active",
      );
    } finally {
      inventory.release();
    }
    if (signal?.aborted) {
      dirty = true;
      return;
    }
    const activeBySession = new Map(active.map((placement) => [placement.sessionId, placement]));
    for (const [sessionId, observation] of observations) {
      if (!hasExactBinding(observation, activeBySession.get(sessionId))) {
        observations.delete(sessionId);
        observationVersion += 1;
      }
    }
    for (const [sessionId, binding] of staleBindings) {
      if (!hasExactBinding(binding, activeBySession.get(sessionId))) {
        staleBindings.delete(sessionId);
      }
    }
    const tasks = active.map((placement) => () => probe(placement, signal));
    await runTasksWithConcurrency({
      tasks,
      limit: DISK_SPACE_PROBE_CONCURRENCY,
      onTaskError: (error, index) => {
        if (signal?.aborted && error === signal.reason) {
          dirty = true;
          return;
        }
        const placement = active[index];
        if (placement && error instanceof StaleWorkerBuildError) {
          staleBindings.set(placement.sessionId, { ...placement });
        }
        params.warn(
          `Worker disk-space check failed${placement ? ` (${placement.sessionId})` : ""}: ${formatErrorMessage(error)}`,
        );
      },
    });
    nextSweepAtMs = Math.min(
      Infinity,
      ...active.map((placement) => {
        const stale = staleBindings.get(placement.sessionId);
        if (
          (stale && hasExactBinding(stale, placement)) ||
          params.runnerAvailability.read(placement)?.status === "offline"
        ) {
          return Infinity;
        }
        const observation = observations.get(placement.sessionId);
        return observation && hasExactBinding(observation, placement)
          ? Math.max(
              now() + DISK_SPACE_RETRY_MS,
              observation.snapshot.observedAtMs + IDLE_DISK_SPACE_REFRESH_MS,
            )
          : now() + DISK_SPACE_RETRY_MS;
      }),
    );
  };

  return {
    read,
    sweep,
    invalidate() {
      dirty = true;
    },
    nextSweepAtMs: () =>
      dirty || lastRunnerVersion !== params.runnerAvailability.version()
        ? now() + DISK_SPACE_RETRY_MS
        : nextSweepAtMs,
    version: () => observationVersion,
  };
}
