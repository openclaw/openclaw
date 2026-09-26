// Diagnostics gateway methods expose bounded stability snapshots while keeping
// malformed queries out of logging internals.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { validateDiagnosticsHeapProfileParams } from "../../../packages/gateway-protocol/src/schema/diagnostics.js";
import { getTrackedWorkerPoolSnapshot } from "../../infra/worker-cpu.js";
import type { DiagnosticProfileOutcome } from "../../logging/diagnostic-profile.js";
import {
  getDiagnosticStabilitySnapshot,
  normalizeDiagnosticStabilityQuery,
} from "../../logging/diagnostic-stability.js";
import { getCommandLaneDiagnostics } from "../../process/command-lane-diagnostics.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

async function captureProfile(
  { client, signal, context, respond, hasCurrentClientAuthority }: GatewayRequestHandlerOptions,
  label: "CPU" | "Heap",
  capture: (authority: {
    signal: AbortSignal;
    hasAuthority: () => boolean;
  }) => Promise<DiagnosticProfileOutcome<unknown>>,
): Promise<void> {
  const lifetime = AbortSignal.any(
    [signal, client?.connectionSignal, context.requestEntryLifetime?.signal].filter(
      (value): value is AbortSignal => value !== undefined,
    ),
  );
  const hasAuthority = () => !client?.invalidated && (hasCurrentClientAuthority?.() ?? true);
  const outcome = await capture({ signal: lifetime, hasAuthority });
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
        ? `${label} profile unavailable: stop active Node tracing, including non-CPU categories, before requesting a profile`
        : `${label} profile unavailable: ${outcome.reason}`;
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, message, {
        details: { reason: outcome.reason, cleanupFailed: outcome.cleanupFailed },
      }),
    );
  }
}

/** Gateway handlers for bounded runtime diagnostics. */
export const diagnosticsHandlers: GatewayRequestHandlers = {
  "diagnostics.cpuProfile": async (options) => {
    const { req, respond } = options;
    if (req.params !== undefined && (!isRecord(req.params) || Object.keys(req.params).length > 0)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "diagnostics.cpuProfile accepts only empty params"),
      );
      return;
    }
    await captureProfile(options, "CPU", async (authority) => {
      const { captureDiagnosticCpuProfile } =
        await import("../../logging/diagnostic-cpu-profile.js");
      return captureDiagnosticCpuProfile(authority);
    });
  },
  "diagnostics.heapProfile": async (options) => {
    const { req, respond } = options;
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
    await captureProfile(options, "Heap", async (authority) => {
      const { captureDiagnosticHeapProfile } =
        await import("../../logging/diagnostic-heap-profile.js");
      return captureDiagnosticHeapProfile({ ...params, ...authority });
    });
  },
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
