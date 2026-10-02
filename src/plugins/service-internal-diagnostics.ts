import { getGatewayProcessInstanceId } from "../gateway/process-instance.js";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  onTrustedInternalDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../infra/diagnostic-otel-listener-provenance.js";
import { registerDiagnosticTracePropagationBridge } from "../infra/diagnostic-trace-propagation.js";
import type {
  ProviderUsageMetricsListener,
  ProviderUsageMetricsSnapshot,
} from "../infra/provider-usage-metrics.types.js";
import {
  recordDiagnosticExporterHealth,
  type DiagnosticExporterHealthUpdate,
} from "../logging/diagnostic-stability.js";
import { resolveRuntimeServiceBuildId } from "../version.js";
import type { PluginRuntimeCapabilityLease } from "./capability-lease.js";
import type { PluginServiceRegistration } from "./registry-types.js";
import type { OpenClawPluginServiceContext } from "./types.js";

export type ObserveProviderUsage = (params: {
  isActive: () => boolean;
  listener: (snapshot: ProviderUsageMetricsSnapshot) => void;
}) => Promise<() => void>;

type TrustedExporterInternalDiagnostics = NonNullable<
  OpenClawPluginServiceContext["internalDiagnostics"]
> & {
  reportExporterHealth: (update: DiagnosticExporterHealthUpdate) => void;
  observeProviderUsage?: (listener: ProviderUsageMetricsListener) => Promise<() => void>;
};

export function createTrustedExporterInternalDiagnostics(params: {
  entry: PluginServiceRegistration;
  lease: PluginRuntimeCapabilityLease;
  observeProviderUsage?: ObserveProviderUsage;
}): TrustedExporterInternalDiagnostics | undefined {
  const { entry, lease, observeProviderUsage } = params;
  const isDiagnosticsExporter =
    entry.pluginId === entry.id &&
    (entry.id === "diagnostics-otel" || entry.id === "diagnostics-prometheus");
  const isOtelExporter = isDiagnosticsExporter && entry.id === "diagnostics-otel";
  const isPrometheusExporter = isDiagnosticsExporter && entry.id === "diagnostics-prometheus";
  const grantsInternalDiagnostics =
    isDiagnosticsExporter && (entry.origin === "bundled" || entry.trustedOfficialInstall === true);
  if (!grantsInternalDiagnostics) {
    return undefined;
  }

  return {
    getRuntimeIdentity: () => {
      lease.assertActive("runtime diagnostic identity");
      const buildId = resolveRuntimeServiceBuildId();
      return {
        processInstanceId: getGatewayProcessInstanceId(),
        ...(buildId ? { buildId } : {}),
      };
    },
    emit: (event, privateData) => {
      lease.assertActive("internal diagnostic emitter");
      emitTrustedDiagnosticEventWithPrivateData(event, privateData);
    },
    onEvent: (listener, filter, options) => {
      lease.assertActive("internal diagnostic listener");
      const trustedListener = isOtelExporter
        ? markTrustedOtelDiagnosticListener(listener)
        : listener;
      return lease.retain(onTrustedInternalDiagnosticEvent(trustedListener, filter, options));
    },
    registerTracePropagationBridge: (bridge) => {
      lease.assertActive("diagnostic trace propagation bridge");
      return lease.retain(registerDiagnosticTracePropagationBridge(bridge));
    },
    reportExporterHealth: (update) => {
      if (lease.isActive()) {
        recordDiagnosticExporterHealth(entry.id, update);
      }
    },
    ...(isPrometheusExporter && observeProviderUsage
      ? {
          observeProviderUsage: async (listener: ProviderUsageMetricsListener) => {
            lease.assertActive("provider usage observer");
            const release = await observeProviderUsage({
              isActive: lease.isActive,
              listener: (snapshot) => {
                if (lease.isActive()) {
                  listener(snapshot);
                }
              },
            });
            return lease.retain(release);
          },
        }
      : {}),
  };
}
