import { getGatewayProcessInstanceId } from "../gateway/process-instance.js";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  onTrustedInternalDiagnosticEvent,
} from "../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../infra/diagnostic-otel-listener-provenance.js";
import { registerDiagnosticTracePropagationBridge } from "../infra/diagnostic-trace-propagation.js";
import { onGatewayWorkMetrics } from "../infra/gateway-work-metrics.js";
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
import type { OpenClawPluginServiceContext } from "./plugin-registration.types.js";
import type { PluginServiceRegistration } from "./registry-types.js";

type TrustedExporterInternalDiagnostics = NonNullable<
  OpenClawPluginServiceContext["internalDiagnostics"]
> & {
  reportExporterHealth: (update: DiagnosticExporterHealthUpdate) => void;
  observeProviderUsage?: (listener: ProviderUsageMetricsListener) => Promise<() => void>;
};

export type ObserveProviderUsage = (params: {
  isActive: () => boolean;
  listener: (snapshot: ProviderUsageMetricsSnapshot) => void;
}) => Promise<() => void>;

export function createPluginServiceDiagnostics(
  entry: PluginServiceRegistration,
  lease: PluginRuntimeCapabilityLease,
  observeProviderUsage?: ObserveProviderUsage,
): TrustedExporterInternalDiagnostics | undefined {
  const isDiagnosticsExporter =
    entry.pluginId === entry.id &&
    (entry.id === "diagnostics-otel" || entry.id === "diagnostics-prometheus");
  if (
    !isDiagnosticsExporter ||
    (entry.origin !== "bundled" && entry.trustedOfficialInstall !== true)
  ) {
    return undefined;
  }
  const isOtelExporter = entry.id === "diagnostics-otel";
  const isPrometheusExporter = entry.id === "diagnostics-prometheus";
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
    onGatewayWorkMetrics: (listener) => {
      lease.assertActive("gateway work metrics listener");
      return lease.retain(onGatewayWorkMetrics(listener));
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
