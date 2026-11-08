import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import {
  validateDiagnosticsHeapProfileParams,
  validateDiagnosticsHeapSnapshotParams,
} from "../../../packages/gateway-protocol/src/schema/diagnostics.js";
import { collectRuntimeCapabilities } from "../../infra/runtime-capabilities.js";
import { getTrackedWorkerPoolSnapshot } from "../../infra/worker-cpu.js";
import type { DiagnosticProfileOutcome } from "../../logging/diagnostic-profile.js";
import {
  getDiagnosticStabilitySnapshot,
  normalizeDiagnosticStabilityQuery,
} from "../../logging/diagnostic-stability.js";
import { getCommandLaneDiagnostics } from "../../process/command-lane-diagnostics.js";
import { respondError } from "./response.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";

function profileHandler<P>(
  label: "CPU profile" | "Heap profile" | "Heap snapshot",
  validate: (params: unknown) => params is P,
  invalidParamsMessage: string,
  capture: (
    params: P,
    authority: { signal: AbortSignal; hasAuthority: () => boolean },
  ) => Promise<DiagnosticProfileOutcome<unknown>>,
): GatewayRequestHandler {
  return async ({ req, client, signal, context, respond, hasCurrentClientAuthority }) => {
    const params = req.params === undefined ? {} : req.params;
    if (!validate(params)) {
      respondError(respond, ErrorCodes.INVALID_REQUEST, invalidParamsMessage);
      return;
    }
    const lifetime = AbortSignal.any(
      [signal, client?.connectionSignal, context.requestEntryLifetime?.signal].filter(
        (value): value is AbortSignal => value !== undefined,
      ),
    );
    const hasAuthority = () => !client?.invalidated && (hasCurrentClientAuthority?.() ?? true);
    const outcome = await capture(params, { signal: lifetime, hasAuthority });
    // A retired connection must not receive the completed profile. The owner has
    // already stopped/disconnected before this handler resolves during shutdown.
    if (lifetime.aborted || !hasAuthority()) {
      return;
    }
    if (outcome.status === "complete") {
      respond(true, outcome.result, undefined);
    } else {
      const message =
        outcome.reason === "tracing-active"
          ? `${label} unavailable: stop active Node tracing, including non-CPU categories, before requesting a profile`
          : `${label} unavailable: ${outcome.reason}`;
      respondError(respond, ErrorCodes.UNAVAILABLE, message, {
        details: { reason: outcome.reason, cleanupFailed: outcome.cleanupFailed },
      });
    }
  };
}

export const diagnosticsHandlers: GatewayRequestHandlers = {
  "diagnostics.capabilities": ({ params, respond }) => {
    if (params !== undefined && (!isRecord(params) || Object.keys(params).length !== 0)) {
      respondError(
        respond,
        ErrorCodes.INVALID_REQUEST,
        "diagnostics.capabilities accepts only empty params",
      );
      return;
    }
    respond(true, collectRuntimeCapabilities(), undefined);
  },
  "diagnostics.cpuProfile": profileHandler(
    "CPU profile",
    (params): params is Record<string, unknown> =>
      isRecord(params) && Object.keys(params).length === 0,
    "diagnostics.cpuProfile accepts only empty params",
    async (_params, authority) => {
      const { captureDiagnosticCpuProfile } =
        await import("../../logging/diagnostic-cpu-profile.js");
      return captureDiagnosticCpuProfile(authority);
    },
  ),
  "diagnostics.heapProfile": profileHandler(
    "Heap profile",
    validateDiagnosticsHeapProfileParams,
    "diagnostics.heapProfile accepts only positive integer durationMs and samplingIntervalBytes, and boolean includeCollected, includeObjectsCollectedByMajorGC and includeObjectsCollectedByMinorGC",
    async (params, authority) => {
      const { captureDiagnosticHeapProfile } =
        await import("../../logging/diagnostic-heap-profile.js");
      return captureDiagnosticHeapProfile({ ...params, ...authority });
    },
  ),
  "diagnostics.heapSnapshot": profileHandler(
    "Heap snapshot",
    validateDiagnosticsHeapSnapshotParams,
    "diagnostics.heapSnapshot accepts only an optional reason string (at most 256 characters)",
    async (params, authority) => {
      const { captureDiagnosticHeapSnapshot } =
        await import("../../logging/diagnostic-heap-snapshot.js");
      return captureDiagnosticHeapSnapshot({ ...params, ...authority });
    },
  ),
  "diagnostics.lanes": ({ respond }) => {
    respond(
      true,
      { ts: Date.now(), ...getCommandLaneDiagnostics(), ...getTrackedWorkerPoolSnapshot() },
      undefined,
    );
  },
  "diagnostics.stability": async ({ params, respond }) => {
    try {
      // Normalization owns parameter bounds so malformed diagnostic requests
      // return a client error instead of leaking logging internals.
      const query = normalizeDiagnosticStabilityQuery(params);
      respond(true, getDiagnosticStabilitySnapshot(query), undefined);
    } catch (err) {
      respondError(
        respond,
        ErrorCodes.INVALID_REQUEST,
        err instanceof Error ? err.message : "invalid diagnostics.stability params",
      );
    }
  },
};
