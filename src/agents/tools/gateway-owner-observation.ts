import { hasInternalDiagnosticEventInterest } from "../../infra/diagnostic-event-listener-presence.js";
import {
  areDiagnosticsEnabledForProcess,
  emitTrustedDiagnosticEvent,
} from "../../infra/diagnostic-events.js";
import { markCoreGatewayOwnerEvent } from "../../infra/diagnostic-gateway-admission-provenance.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  createDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { observeGatewayToolCallerOwner } from "./gateway-caller-context.js";

/** One fresh diagnostic span per actual before-tool invocation, never execution authority. */
export function emitBeforeToolGatewayOwnerObservation(context: {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  trace?: DiagnosticTraceContext;
  signal?: AbortSignal;
}): DiagnosticTraceContext | undefined {
  try {
    if (
      !areDiagnosticsEnabledForProcess() ||
      !hasInternalDiagnosticEventInterest("gateway.run.owner")
    ) {
      return undefined;
    }
    const trace = freezeDiagnosticTraceContext(
      context.trace
        ? createChildDiagnosticTraceContext(context.trace)
        : createDiagnosticTraceContext(),
    );
    emitTrustedDiagnosticEvent(
      markCoreGatewayOwnerEvent({
        type: "gateway.run.owner",
        phase: "before_tool_call" as const,
        gatewayOwner: observeGatewayToolCallerOwner(context),
        trace,
      }),
    );
    return trace;
  } catch {
    // Missing observation is not permission to alter policy or tool execution.
    return undefined;
  }
}
