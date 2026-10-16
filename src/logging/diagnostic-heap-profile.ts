import type { HeapProfiler, Runtime } from "node:inspector";
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

export function sanitizeDiagnosticHeapProfile(
  profile: SamplingProfile,
  packageRoot: string | null,
  metadata: Metadata,
): HeapProfileResult {
  const samples = profile.samples;
  type Row = AllocationSummary & { node: SamplingNode; parent?: Row };
  const rows = new Map<number, Row>();
  const pending: Array<{ source: SamplingNode; parent?: Row }> = [{ source: profile.head }];
  let redactedNodeCount = 0;
  for (const { source, parent } of pending) {
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
      stack: [callFrame, ...(parent?.stack.slice(0, 7) ?? [])],
      selfBytes: node.selfSize,
      totalBytes: node.selfSize,
      count: 0,
    };
    rows.set(node.id, row);
    parent?.node.children.push(node);
    for (const child of source.children) {
      pending.push({ source: child, parent: row });
    }
  }
  const safeSamples: SamplingProfile["samples"] = [];
  let unattributedSampleCount = 0;
  let unattributedSampleBytes = 0;
  for (const sample of samples) {
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
  for (const row of ordered.toReversed()) {
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
  const groups = new Map<string, AllocationSummary>();
  for (const { stack, selfBytes, totalBytes, count } of ordered) {
    if (totalBytes === 0) {
      continue;
    }
    const key = JSON.stringify(stack);
    const group = groups.get(key);
    if (group) {
      group.selfBytes += selfBytes;
      group.totalBytes += totalBytes;
      group.count += count;
    } else {
      groups.set(key, { stack, selfBytes, totalBytes, count });
    }
  }
  const result: HeapProfileResult = { ...common, truncated: true, summary: [] };
  let bytes = Buffer.byteLength(JSON.stringify(result));
  for (const row of [...groups.values()].toSorted(
    (a, b) => b.totalBytes - a.totalBytes || b.selfBytes - a.selfBytes,
  )) {
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
  const durationMs = Math.min(maxDurationMs, Math.max(1, options.durationMs ?? 5_000));
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
