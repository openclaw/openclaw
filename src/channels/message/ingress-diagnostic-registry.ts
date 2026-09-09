import {
  CHANNEL_INGRESS_OPERATION_KINDS,
  type ChannelIngressActiveOperationSnapshot,
  type ChannelIngressActiveOperationsSnapshot,
  type ChannelIngressObservabilitySnapshot,
  type ChannelIngressObservationRecordRef,
  type ChannelIngressOperationKind,
} from "./ingress-observability-contract.js";
import { buildChannelIngressObservabilitySnapshot } from "./ingress-observability-snapshot.js";

type ChannelIngressDiagnosticActiveOperations =
  | readonly ChannelIngressActiveOperationSnapshot[]
  | ChannelIngressActiveOperationsSnapshot;

type MutableChannelIngressActiveOperationsSnapshot = {
  operations: ChannelIngressActiveOperationSnapshot[];
  unknownProgressEvents: ChannelIngressObservationRecordRef[];
  overflowByKind: Partial<Record<ChannelIngressOperationKind, number>>;
};

type ChannelIngressDiagnosticSource = {
  id: symbol;
  scopeKey: string;
  getActiveOperations: () => ChannelIngressDiagnosticActiveOperations;
  getSnapshot: (
    now: number,
    activeOperations: ChannelIngressActiveOperationsSnapshot,
  ) => Promise<ChannelIngressObservabilitySnapshot> | ChannelIngressObservabilitySnapshot;
};

type ChannelIngressDiagnosticRegistry = {
  sources: Map<symbol, ChannelIngressDiagnosticSource>;
};

const CHANNEL_INGRESS_DIAGNOSTIC_REGISTRY_KEY = Symbol.for(
  "openclaw.channelIngress.diagnosticRegistry.v1",
);

function isChannelIngressDiagnosticRegistry(
  value: unknown,
): value is ChannelIngressDiagnosticRegistry {
  return (
    typeof value === "object" && value !== null && Reflect.get(value, "sources") instanceof Map
  );
}

function getChannelIngressDiagnosticRegistry(): ChannelIngressDiagnosticRegistry {
  const existing = Reflect.get(globalThis, CHANNEL_INGRESS_DIAGNOSTIC_REGISTRY_KEY);
  if (isChannelIngressDiagnosticRegistry(existing)) {
    return existing;
  }
  const registry: ChannelIngressDiagnosticRegistry = { sources: new Map() };
  Object.defineProperty(globalThis, CHANNEL_INGRESS_DIAGNOSTIC_REGISTRY_KEY, {
    configurable: true,
    enumerable: false,
    value: registry,
    writable: false,
  });
  return registry;
}

function hasOperationSnapshot(
  source: ChannelIngressDiagnosticActiveOperations,
): source is ChannelIngressActiveOperationsSnapshot {
  return typeof source === "object" && source !== null && "operations" in source;
}

function appendActiveOperations(
  target: MutableChannelIngressActiveOperationsSnapshot,
  source: ChannelIngressDiagnosticActiveOperations,
): void {
  if (!hasOperationSnapshot(source)) {
    target.operations.push(...source);
    return;
  }
  target.operations.push(...source.operations);
  target.unknownProgressEvents.push(...(source.unknownProgressEvents ?? []));
  for (const kind of CHANNEL_INGRESS_OPERATION_KINDS) {
    const count = source.overflowByKind?.[kind] ?? 0;
    if (count > 0) {
      target.overflowByKind[kind] = (target.overflowByKind[kind] ?? 0) + count;
    }
  }
}

export function registerChannelIngressDiagnosticSource(params: {
  scopeKey?: string;
  getActiveOperations: () => ChannelIngressDiagnosticActiveOperations;
  getSnapshot: ChannelIngressDiagnosticSource["getSnapshot"];
}): () => void {
  const id = Symbol("channel-ingress-diagnostic-source");
  getChannelIngressDiagnosticRegistry().sources.set(id, {
    id,
    scopeKey: params.scopeKey ?? "",
    getActiveOperations: params.getActiveOperations,
    getSnapshot: params.getSnapshot,
  });
  return () => {
    getChannelIngressDiagnosticRegistry().sources.delete(id);
  };
}

export async function getDiagnosticIngressSnapshot(
  now = Date.now(),
): Promise<ChannelIngressObservabilitySnapshot> {
  const sources = [...getChannelIngressDiagnosticRegistry().sources.values()];
  if (sources.length === 0) {
    return buildChannelIngressObservabilitySnapshot({
      rows: [],
      sampledAt: now,
      status: "unknown",
    });
  }
  const activeOperations: MutableChannelIngressActiveOperationsSnapshot = {
    operations: [],
    overflowByKind: {},
    unknownProgressEvents: [],
  };
  for (const source of sources) {
    try {
      appendActiveOperations(activeOperations, source.getActiveOperations());
    } catch {
      return buildChannelIngressObservabilitySnapshot({
        rows: [],
        sampledAt: now,
        status: "unknown",
      });
    }
  }
  const snapshotsByScope = new Map<string, ChannelIngressDiagnosticSource>();
  for (const source of sources) {
    snapshotsByScope.set(source.scopeKey, source);
  }
  if (snapshotsByScope.size !== 1) {
    return buildChannelIngressObservabilitySnapshot({
      rows: [],
      sampledAt: now,
      activeOperations,
      status: "unknown",
    });
  }
  try {
    const source = [...snapshotsByScope.values()][0];
    if (!source) {
      return buildChannelIngressObservabilitySnapshot({
        rows: [],
        sampledAt: now,
        status: "unknown",
      });
    }
    return await source.getSnapshot(now, activeOperations);
  } catch {
    return buildChannelIngressObservabilitySnapshot({
      rows: [],
      sampledAt: now,
      activeOperations,
      status: "unknown",
    });
  }
}

export function resetRegisteredChannelIngressDiagnosticSourcesForTest(): void {
  getChannelIngressDiagnosticRegistry().sources.clear();
}
