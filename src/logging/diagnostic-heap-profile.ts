import type { HeapProfiler, Runtime } from "node:inspector";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { DiagnosticsHeapProfileParams } from "../../packages/gateway-protocol/src/schema/diagnostics.js";
import { boundedJsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import {
  assertProfile,
  captureDiagnosticProfile,
  DIAGNOSTIC_PROFILE_MAX_BYTES,
  sanitizeDiagnosticProfileFrame,
} from "./diagnostic-profile.js";

// Node's inspector declarations omit these fields from the current V8 protocol.
type SamplingNode = HeapProfiler.SamplingHeapProfileNode & { id: number; children: SamplingNode[] };
type SamplingProfile = {
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
  heapUsedBefore: number;
  heapUsedAfter: number;
  rssBefore: number;
  rssAfter: number;
};
type HeapProfileResult = Metadata & {
  redactedNodeCount: number;
  unattributedSampleCount: number;
  unattributedSampleBytes: number;
  truncated: boolean;
} & ({ profile: SamplingProfile } | { summary: AllocationSummary[] });

function boundProfile(
  profile: HeapProfiler.SamplingHeapProfile,
  packageRoot: string | null,
  metadata: Metadata,
): HeapProfileResult {
  assertProfile(Boolean(profile?.head) && isRecord(profile) && Array.isArray(profile.samples));
  const samples = profile.samples;
  type Row = AllocationSummary & { node: SamplingNode; parent?: Row };
  const rows = new Map<number, Row>();
  const pending: Array<{ source: HeapProfiler.SamplingHeapProfileNode; parent?: Row }> = [
    { source: profile.head },
  ];
  let redactedNodeCount = 0;
  for (const { source, parent } of pending) {
    assertProfile(
      isRecord(source) &&
        typeof source.id === "number" &&
        Number.isSafeInteger(source.id) &&
        source.id > 0 &&
        !rows.has(source.id) &&
        Number.isSafeInteger(source.selfSize) &&
        source.selfSize >= 0 &&
        Array.isArray(source.children),
    );
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
    assertProfile(
      isRecord(sample) &&
        typeof sample.nodeId === "number" &&
        Number.isSafeInteger(sample.nodeId) &&
        sample.nodeId > 0 &&
        typeof sample.size === "number" &&
        Number.isSafeInteger(sample.size) &&
        sample.size >= 0 &&
        typeof sample.ordinal === "number" &&
        Number.isSafeInteger(sample.ordinal) &&
        sample.ordinal >= 0,
    );
    const row = rows.get(sample.nodeId);
    if (!row) {
      // V8 can sample profile construction after a call site was translated.
      // Preserve native tree sizes and report the missing attribution separately.
      unattributedSampleCount++;
      unattributedSampleBytes += sample.size;
      assertProfile(Number.isSafeInteger(unattributedSampleBytes));
      continue;
    }
    row.count++;
    safeSamples.push({ size: sample.size, nodeId: sample.nodeId, ordinal: sample.ordinal });
  }
  const ordered = [...rows.values()];
  for (const row of ordered.toReversed()) {
    if (row.parent) {
      row.parent.totalBytes += row.totalBytes;
      assertProfile(Number.isSafeInteger(row.parent.totalBytes));
    }
  }
  const head = ordered[0]?.node;
  assertProfile(head !== undefined);
  const common = {
    ...metadata,
    redactedNodeCount,
    unattributedSampleCount,
    unattributedSampleBytes,
  };
  const raw: HeapProfileResult = {
    ...common,
    truncated: unattributedSampleCount > 0,
    profile: { head, samples: safeSamples },
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
  const durationMs = Math.min(30_000, Math.max(1, options.durationMs ?? 5_000));
  const samplingIntervalBytes = Math.max(4_096, options.samplingIntervalBytes ?? 32_768);
  return captureDiagnosticProfile({
    signal: options.signal,
    hasAuthority: options.hasAuthority,
    durationMs,
    setup: (session) => session.post("HeapProfiler.enable"),
    start: (session) =>
      session.post("HeapProfiler.startSampling", {
        samplingInterval: samplingIntervalBytes,
      }),
    stop: (session) => session.post("HeapProfiler.stopSampling"),
    disable: (session) => session.post("HeapProfiler.disable"),
    sanitize: (profile, packageRoot, measurement) =>
      boundProfile(profile, packageRoot, {
        durationMs: measurement.durationMs,
        samplingIntervalBytes,
        heapUsedBefore: measurement.before.heapUsed,
        heapUsedAfter: measurement.after.heapUsed,
        rssBefore: measurement.before.rss,
        rssAfter: measurement.after.rss,
      }),
  });
}
