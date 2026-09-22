import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import type { SessionCatalogHost } from "../../../packages/gateway-protocol/src/index.js";
import { areDiagnosticsEnabledForProcess } from "../../infra/diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";
import type { SessionCatalogListTiming } from "./session-catalog-list-admission.js";

const catalogLog = createSubsystemLogger("gateway/session-catalog");

function countReturnedHosts(hosts: SessionCatalogHost[]) {
  const counts = {
    returnedHostCount: hosts.length,
    hostCountsComplete: hosts.length <= 512,
    returnedGatewayHostCount: 0,
    returnedNodeHostCount: 0,
    returnedConnectedHostCount: 0,
    returnedErrorHostCount: 0,
  };
  for (let index = 0; index < Math.min(hosts.length, 512); index++) {
    const host = hosts[index]!;
    counts.returnedGatewayHostCount += Number(host.kind === "gateway");
    counts.returnedNodeHostCount += Number(host.kind === "node");
    counts.returnedConnectedHostCount += Number(host.connected);
    counts.returnedErrorHostCount += Number(host.error !== undefined);
  }
  return counts;
}

export function startSessionCatalogListDiagnostics(
  provider: SessionCatalogProvider,
  signal?: AbortSignal,
) {
  if (!areDiagnosticsEnabledForProcess() || !catalogLog.isEnabled("warn")) {
    return undefined;
  }
  const id = provider.id;
  const providerId = typeof id === "string" && id.length <= 256 ? id : undefined;
  const trace = getActiveDiagnosticTraceContext();
  const startedAt = performance.now();
  const timing: SessionCatalogListTiming = {};
  let providerStartedAt: number | undefined;
  return {
    timing,
    providerStarted() {
      providerStartedAt = performance.now();
    },
    finish(outcome: "resolved" | "rejected", hosts?: SessionCatalogHost[]) {
      const finishedAt = performance.now();
      const elapsedMs = finishedAt - startedAt;
      if (elapsedMs < 1_000 || !areDiagnosticsEnabledForProcess()) {
        return;
      }
      try {
        // Count returned hosts only; later waitUntil publications have their own lifetime.
        const hostCounts = hosts === undefined ? undefined : countReturnedHosts(hosts);
        runWithDiagnosticTraceContext(trace, () =>
          catalogLog.warn("slow session catalog provider list", {
            operation: "sessions.catalog.list",
            pid: process.pid,
            threadId,
            isMainThread,
            ...(providerId === undefined
              ? {}
              : { providerIdHash: createHash("sha256").update(providerId).digest("hex") }),
            elapsedMs: Math.round(elapsedMs),
            admitted: timing.admittedAt !== undefined,
            providerInvoked: providerStartedAt !== undefined,
            ...(timing.admittedAt === undefined
              ? {}
              : { admissionWaitMs: Math.round(timing.admittedAt - startedAt) }),
            ...(providerStartedAt === undefined || timing.settledAt === undefined
              ? {}
              : { providerElapsedMs: Math.round(timing.settledAt - providerStartedAt) }),
            ...(timing.stepCount === undefined ? {} : { stepCount: timing.stepCount }),
            ...(timing.admittedStepMs === undefined
              ? {}
              : { admittedStepMs: Math.round(timing.admittedStepMs) }),
            ...(timing.continuationWaitMs === undefined
              ? {}
              : { continuationWaitMs: Math.round(timing.continuationWaitMs) }),
            ...(timing.settledAt === undefined
              ? {}
              : { completionDelayMs: Math.round(finishedAt - timing.settledAt) }),
            outcome,
            signalAborted: signal?.aborted === true,
            ...hostCounts,
          }),
        );
      } catch {
        // Diagnostic sinks and plugin-owned result inspection cannot replace the result or error.
      }
    },
  };
}
