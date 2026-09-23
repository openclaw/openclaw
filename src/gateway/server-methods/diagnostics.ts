// Diagnostics gateway methods expose bounded stability snapshots while keeping
// malformed queries out of logging internals.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { validateDiagnosticsHeapProfileParams } from "../../../packages/gateway-protocol/src/schema/diagnostics.js";
import {
  getDiagnosticStabilitySnapshot,
  normalizeDiagnosticStabilityQuery,
} from "../../logging/diagnostic-stability.js";
import { getCommandLaneDiagnostics } from "../../process/command-lane-diagnostics.js";
import type { GatewayRequestHandlers } from "./types.js";

/** Gateway handlers for bounded runtime diagnostics. */
export const diagnosticsHandlers: GatewayRequestHandlers = {
  "diagnostics.cpuProfile": async ({
    req,
    client,
    signal,
    context,
    respond,
    hasCurrentClientAuthority,
  }) => {
    if (req.params !== undefined && (!isRecord(req.params) || Object.keys(req.params).length > 0)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "diagnostics.cpuProfile accepts only empty params"),
      );
      return;
    }
    const lifetime = AbortSignal.any(
      [signal, client?.connectionSignal, context.requestEntryLifetime?.signal].filter(
        (value): value is AbortSignal => value !== undefined,
      ),
    );
    const hasAuthority = () => !client?.invalidated && (hasCurrentClientAuthority?.() ?? true);
    const { captureDiagnosticCpuProfile } = await import("../../logging/diagnostic-cpu-profile.js");
    const outcome = await captureDiagnosticCpuProfile({ signal: lifetime, hasAuthority });
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
          ? "CPU profile unavailable: stop active Node tracing, including non-CPU categories, before requesting a profile"
          : `CPU profile unavailable: ${outcome.reason}`;
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, message, {
          details: { reason: outcome.reason, cleanupFailed: outcome.cleanupFailed },
        }),
      );
    }
  },
  "diagnostics.heapProfile": async ({
    req,
    client,
    signal,
    context,
    respond,
    hasCurrentClientAuthority,
  }) => {
    const params = req.params === undefined ? {} : req.params;
    if (!validateDiagnosticsHeapProfileParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "diagnostics.heapProfile accepts only positive integer durationMs and samplingIntervalBytes",
        ),
      );
      return;
    }
    const lifetime = AbortSignal.any(
      [signal, client?.connectionSignal, context.requestEntryLifetime?.signal].filter(
        (value): value is AbortSignal => value !== undefined,
      ),
    );
    const hasAuthority = () => !client?.invalidated && (hasCurrentClientAuthority?.() ?? true);
    const { captureDiagnosticHeapProfile } =
      await import("../../logging/diagnostic-heap-profile.js");
    const outcome = await captureDiagnosticHeapProfile({
      ...params,
      signal: lifetime,
      hasAuthority,
    });
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
          ? "Heap profile unavailable: stop active Node tracing, including non-CPU categories, before requesting a profile"
          : `Heap profile unavailable: ${outcome.reason}`;
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, message, {
          details: { reason: outcome.reason, cleanupFailed: outcome.cleanupFailed },
        }),
      );
    }
  },
  "diagnostics.lanes": ({ respond }) => {
    respond(true, { ts: Date.now(), ...getCommandLaneDiagnostics() }, undefined);
  },
  "diagnostics.stability": async ({ params, respond }) => {
    try {
      // Normalization owns parameter bounds so malformed diagnostic requests
      // return a client error instead of leaking logging internals.
      const query = normalizeDiagnosticStabilityQuery(params);
      respond(true, getDiagnosticStabilitySnapshot(query), undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          err instanceof Error ? err.message : "invalid diagnostics.stability params",
        ),
      );
    }
  },
};
