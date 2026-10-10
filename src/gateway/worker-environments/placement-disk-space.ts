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
  placements: Pick<WorkerSessionPlacementStore, "get" | "readChangeSnapshot" | "readProjection">;
  environments: Pick<WorkerEnvironmentService, "startTunnel">;
  runnerAvailability: Pick<WorkerPlacementRunnerAvailabilityReader, "read">;
  warn: (message: string) => void;
  now?: () => number;
}) {
  const observations = new Map<string, DiskSpaceObservation>();
  const staleBindings = new Map<string, ActivePlacement>();
  const now = params.now ?? Date.now;
  let observationVersion = 0;

  const read: WorkerPlacementDiskSpaceReader["read"] = (placement) => {
    const observation = observations.get(placement.sessionId);
    return observation && hasExactBinding(observation, placement)
      ? observation.snapshot
      : undefined;
  };

  const probe = async (placement: ActivePlacement): Promise<void> => {
    // A stale worker build cannot recover until its placement binding changes.
    const stale = staleBindings.get(placement.sessionId);
    if (stale && hasExactBinding(stale, placement)) {
      return;
    }
    if (params.runnerAvailability.read(placement)?.status === "offline") {
      return;
    }
    const tunnel = await params.environments.startTunnel({
      environmentId: placement.environmentId,
      ownerEpoch: placement.activeOwnerEpoch,
    });
    const result = await tunnel.runWorkspaceCommand({
      transportRetry: "idempotent",
      argv: ["node", "-e", REMOTE_DISK_SPACE_PROBE_JS, placement.remoteWorkspaceDir],
      timeoutMs: DISK_SPACE_PROBE_TIMEOUT_MS,
    });
    if (result.termination !== "exit" || result.code !== 0) {
      throw new Error("Worker disk-space check command failed");
    }
    const snapshot = parseDiskSpaceProbe(
      result.stdout,
      Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(now()))),
    );
    const current = params.placements.get(placement.sessionId);
    const candidate = { ...placement, snapshot } satisfies DiskSpaceObservation;
    // Tunnel work can outlive an owner. Accept the sample only for the exact active generation.
    if (!hasExactBinding(candidate, current)) {
      return;
    }
    const previous = read(current);
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

  const sweep = async (): Promise<void> => {
    const identities = await params.placements.readChangeSnapshot();
    const projection = await params.placements.readProjection(
      identities.map(({ sessionId }) => sessionId),
      { current: true },
    );
    const active = identities
      .map(({ sessionId }) => projection.placements.get(sessionId))
      .filter((placement): placement is ActivePlacement => placement?.state === "active");
    for (const [sessionId, observation] of observations) {
      if (!hasExactBinding(observation, params.placements.get(sessionId))) {
        observations.delete(sessionId);
        observationVersion += 1;
      }
    }
    for (const [sessionId, binding] of staleBindings) {
      if (!hasExactBinding(binding, params.placements.get(sessionId))) {
        staleBindings.delete(sessionId);
      }
    }
    const tasks = active.map((placement) => () => probe(placement));
    await runTasksWithConcurrency({
      tasks,
      limit: DISK_SPACE_PROBE_CONCURRENCY,
      onTaskError: (error, index) => {
        const placement = active[index];
        if (placement && error instanceof StaleWorkerBuildError) {
          staleBindings.set(placement.sessionId, { ...placement });
        }
        params.warn(
          `Worker disk-space check failed${placement ? ` (${placement.sessionId})` : ""}: ${formatErrorMessage(error)}`,
        );
      },
    });
  };

  return { read, sweep, version: () => observationVersion };
}
