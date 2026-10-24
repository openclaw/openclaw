import type { HeapProfiler, Runtime } from "node:inspector";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { HeapSpaceInfo } from "node:v8";
import type { DiagnosticsHeapProfileParams } from "../../packages/gateway-protocol/src/schema/diagnostics.js";
import { boundedJsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import {
  captureDiagnosticProfile,
  createInspectorProfileCapture,
  DIAGNOSTIC_PROFILE_MAX_BYTES,
  sanitizeDiagnosticProfileFrame,
} from "./diagnostic-profile.js";

// Node's inspector declarations omit these fields from the current V8 protocol.
type SamplingNode = Omit<HeapProfiler.SamplingHeapProfileNode, "children"> & {
  id: number;
  children: SamplingNode[];
};
export type SamplingProfile = {
  head: SamplingNode;
  samples: Array<{ size: number; nodeId: number; ordinal: number }>;
};
type AllocationSummary = {
  stack: [Runtime.CallFrame, ...Runtime.CallFrame[]];
  selfBytes: number;
  totalBytes: number;
  count: number;
};
type Metadata = {
  durationMs: number;
  requestedDurationMs: number;
  effectiveDurationMs: number;
  actualDurationMs: number;
  durationLimitReason: "collected-samples" | "maximum-duration" | null;
  samplingIntervalBytes: number;
  includeObjectsCollectedByMajorGC: boolean;
  includeObjectsCollectedByMinorGC: boolean;
  heapUsedBefore: number;
  heapUsedAfter: number;
  heapSpacesBefore: HeapSpaceInfo[];
  heapSpacesAfter: HeapSpaceInfo[];
  rssBefore: number;
  rssAfter: number;
};
type HeapProfileResult = Metadata & {
  redactedNodeCount: number;
  unattributedSampleCount: number;
  unattributedSampleBytes: number;
  truncated: boolean;
} & ({ profile: SamplingProfile } | { summary: AllocationSummary[] });

async function sortAllocationSummaries(groups: Iterable<AllocationSummary>) {
  const compare = (a: AllocationSummary, b: AllocationSummary) =>
    b.totalBytes - a.totalBytes || b.selfBytes - a.selfBytes;
  let runs: AllocationSummary[][] = [];
  let batch: AllocationSummary[] = [];
  for (const row of groups) {
    batch.push(row);
    if (batch.length === 2048) {
      runs.push(batch.toSorted(compare));
      batch = [];
      await nextTurn();
    }
  }
  if (batch.length) {
    runs.push(batch.toSorted(compare));
  }
  // Stable merges preserve the original insertion order for equal-sized stacks.
  while (runs.length > 1) {
    const mergedRuns: AllocationSummary[][] = [];
    for (let index = 0; index < runs.length; index += 2) {
      const left = runs[index]!;
      const right = runs[index + 1];
      if (!right) {
        mergedRuns.push(left);
        continue;
      }
      const merged: AllocationSummary[] = [];
      let a = 0;
      let b = 0;
      while (a < left.length || b < right.length) {
        merged.push(
          b === right.length || (a < left.length && compare(left[a]!, right[b]!) <= 0)
            ? left[a++]!
            : right[b++]!,
        );
        if (merged.length % 2048 === 0) {
          await nextTurn();
        }
      }
      mergedRuns.push(merged);
    }
    runs = mergedRuns;
  }
  return runs[0] ?? [];
}

export async function sanitizeDiagnosticHeapProfile(
  profile: SamplingProfile,
  packageRoot: string | null,
  metadata: Metadata,
): Promise<HeapProfileResult> {
  const samples = profile.samples;
  type Row = {
    node: SamplingNode;
    parent?: Row;
    totalBytes: number;
    count: number;
    frameId: number;
  };
  const rows = new Map<number, Row>();
  const pending: Array<{ source: SamplingNode; parent?: Row }> = [{ source: profile.head }];
  let redactedNodeCount = 0;
  // Bound uninterrupted work without cloning the raw profile into another isolate.
  let work = 0;
  for (const { source, parent } of pending) {
    if (++work % 1024 === 0) {
      await nextTurn();
    }
    const { callFrame, redacted } = sanitizeDiagnosticProfileFrame(source.callFrame, packageRoot);
    redactedNodeCount += Number(redacted);
    const node: SamplingNode = {
      id: source.id,
      callFrame,
      selfSize: source.selfSize,
      children: [],
    };
    const row: Row = {
      node,
      parent,
      totalBytes: node.selfSize,
      count: 0,
      frameId: 0,
    };
    rows.set(node.id, row);
    parent?.node.children.push(node);
    for (const child of source.children) {
      pending.push({ source: child, parent: row });
      if (++work % 1024 === 0) {
        await nextTurn();
      }
    }
  }
  pending.length = 0;
  const safeSamples: SamplingProfile["samples"] = [];
  let unattributedSampleCount = 0;
  let unattributedSampleBytes = 0;
  for (const sample of samples) {
    if (++work % 1024 === 0) {
      await nextTurn();
    }
    const row = rows.get(sample.nodeId);
    if (!row) {
      // V8 can sample profile construction after a call site was translated.
      // Preserve native tree sizes and report the missing attribution separately.
      unattributedSampleCount++;
      unattributedSampleBytes += sample.size;
      continue;
    }
    row.count++;
    safeSamples.push({ size: sample.size, nodeId: sample.nodeId, ordinal: sample.ordinal });
  }
  const ordered = [...rows.values()];
  rows.clear();
  for (let index = ordered.length - 1; index >= 0; index--) {
    if (++work % 1024 === 0) {
      await nextTurn();
    }
    const row = ordered[index]!;
    if (row.parent) {
      row.parent.totalBytes += row.totalBytes;
    }
  }
  const common = {
    ...metadata,
    redactedNodeCount,
    unattributedSampleCount,
    unattributedSampleBytes,
  };
  const raw: HeapProfileResult = {
    ...common,
    truncated: unattributedSampleCount > 0,
    profile: { head: ordered[0]!.node, samples: safeSamples },
  };
  if (boundedJsonUtf8Bytes(raw, DIAGNOSTIC_PROFILE_MAX_BYTES).complete) {
    return raw;
  }

  // Collapse repeated leaf-first call stacks, retaining eight frames per entry.
  // Intern exact sanitized frames so each stack key need not repeat their JSON.
  const frameIds = new Map<string, number>();
  const groups = new Map<string, AllocationSummary>();
  const stackIds: number[] = [];
  for (const row of ordered) {
    if (++work % 1024 === 0) {
      await nextTurn();
    }
    const frameKey = JSON.stringify(row.node.callFrame);
    let frameId = frameIds.get(frameKey);
    if (frameId === undefined) {
      frameId = frameIds.size;
      frameIds.set(frameKey, frameId);
    }
    row.frameId = frameId;
    const { totalBytes, count } = row;
    if (totalBytes === 0) {
      continue;
    }
    const selfBytes = row.node.selfSize;
    const stack: AllocationSummary["stack"] = [row.node.callFrame];
    stackIds.length = 0;
    stackIds.push(frameId);
    for (let parent = row.parent; parent && stack.length < 8; parent = parent.parent) {
      stack.push(parent.node.callFrame);
      stackIds.push(parent.frameId);
    }
    const key = stackIds.join(",");
    const group = groups.get(key);
    if (group) {
      group.selfBytes += selfBytes;
      group.totalBytes += totalBytes;
      group.count += count;
    } else {
      groups.set(key, { stack, selfBytes, totalBytes, count });
    }
  }
  frameIds.clear();
  ordered.length = 0;
  const result: HeapProfileResult = { ...common, truncated: true, summary: [] };
  let bytes = Buffer.byteLength(JSON.stringify(result));
  for (const row of await sortAllocationSummaries(groups.values())) {
    if (++work % 1024 === 0) {
      await nextTurn();
    }
    const extra = Buffer.byteLength(JSON.stringify(row)) + Number(result.summary.length > 0);
    if (bytes + extra > DIAGNOSTIC_PROFILE_MAX_BYTES) {
      break;
    }
    result.summary.push(row);
    bytes += extra;
  }
  return result;
}

/** Samples allocations in the main isolate without a snapshot or disk output. */
export function captureDiagnosticHeapProfile(
  options: DiagnosticsHeapProfileParams & {
    signal: AbortSignal;
    hasAuthority: () => boolean;
  },
) {
  const samplingIntervalBytes = Math.max(4_096, options.samplingIntervalBytes ?? 32_768);
  const collectionOptions = {
    includeObjectsCollectedByMajorGC:
      options.includeObjectsCollectedByMajorGC ?? options.includeCollected ?? false,
    includeObjectsCollectedByMinorGC:
      options.includeObjectsCollectedByMinorGC ?? options.includeCollected ?? false,
  };
  const maxDurationMs =
    collectionOptions.includeObjectsCollectedByMajorGC ||
    collectionOptions.includeObjectsCollectedByMinorGC
      ? 30_000
      : 900_000;
  const requestedDurationMs = options.durationMs ?? 5_000;
  const durationMs = Math.min(maxDurationMs, Math.max(1, requestedDurationMs));
  return captureDiagnosticProfile({
    signal: options.signal,
    hasAuthority: options.hasAuthority,
    durationMs,
    create: (inspector) =>
      createInspectorProfileCapture(inspector, {
        setup: (session) => session.post("HeapProfiler.enable"),
        start: (session) =>
          session.post("HeapProfiler.startSampling", {
            samplingInterval: samplingIntervalBytes,
            ...collectionOptions,
          }),
        stop: (session) => session.post("HeapProfiler.stopSampling"),
        disable: (session) => session.post("HeapProfiler.disable"),
      }),
    sanitize: (profile, packageRoot, measurement) =>
      // SAFETY: The native protocol includes IDs and samples omitted by Node's declarations.
      sanitizeDiagnosticHeapProfile(profile as SamplingProfile, packageRoot, {
        durationMs: measurement.durationMs,
        requestedDurationMs,
        effectiveDurationMs: durationMs,
        actualDurationMs: measurement.durationMs,
        durationLimitReason:
          requestedDurationMs <= maxDurationMs
            ? null
            : maxDurationMs === 30_000
              ? "collected-samples"
              : "maximum-duration",
        samplingIntervalBytes,
        ...collectionOptions,
        heapUsedBefore: measurement.before.heapUsed,
        heapUsedAfter: measurement.after.heapUsed,
        heapSpacesBefore: measurement.before.heapSpaces,
        heapSpacesAfter: measurement.after.heapSpaces,
        rssBefore: measurement.before.rss,
        rssAfter: measurement.after.rss,
      }),
  });
}
