import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
} from "./diagnostic-events.js";

type TrustedOtelDiagnosticEventPrivateData = DiagnosticEventPrivateData &
  Readonly<{
    hostPluginId?: string;
  }>;

export function createDiagnosticMetadataForListener(
  metadata: DiagnosticEventMetadata,
): DiagnosticEventMetadata {
  return Object.freeze({ ...metadata });
}

export function cloneDiagnosticEventForListener(
  event: DiagnosticEventPayload,
): DiagnosticEventPayload {
  return deepFreezeDiagnosticValue(structuredClone(event));
}

export function cloneDiagnosticPrivateDataForListener(
  privateData: DiagnosticEventPrivateData | undefined,
): DiagnosticEventPrivateData {
  if (!privateData) {
    return Object.freeze({});
  }
  return deepFreezeDiagnosticValue(structuredClone(privateData));
}

export function cloneDiagnosticPrivateDataForOtelListener(
  privateData: DiagnosticEventPrivateData | undefined,
  hostPluginId: string | undefined,
): TrustedOtelDiagnosticEventPrivateData {
  // Keep the third-argument transport for independently updated official OTel installs.
  // Only the marked OTel listener receives this host-owned field.
  const cloned = structuredClone(privateData ?? {});
  Reflect.deleteProperty(cloned, "hostPluginId");
  return deepFreezeDiagnosticValue(hostPluginId ? Object.assign(cloned, { hostPluginId }) : cloned);
}

export function deepFreezeDiagnosticValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreezeDiagnosticValue(item, seen);
    }
    return Object.freeze(value);
  }
  for (const nested of Object.values(value)) {
    deepFreezeDiagnosticValue(nested, seen);
  }
  return Object.freeze(value);
}
