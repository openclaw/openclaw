// Gateway RPC handlers for cooperative, host-neutral process suspension.
import {
  ErrorCodes,
  errorShape,
  validateGatewaySuspendPrepareParams,
  validateGatewaySuspendResumeParams,
  validateGatewaySuspendStatusParams,
  validateGatewaySuspendHandoffParams,
  type GatewaySuspendPrepareResult,
  type GatewaySuspendStatusResult,
  validateGatewaySuspendReaderParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  armGatewaySuspendHandoff,
  getGatewaySuspendStatus,
  prepareGatewaySuspend,
  resumeGatewaySuspend,
  prepareGatewaySuspendedReader,
} from "../../infra/gateway-suspend-coordinator.js";
import { getGatewayProcessInstanceId } from "../process-instance.js";
import { createGatewayServerActiveWorkInspectors } from "../server-active-work.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestContext } from "./shared-types.js";
import type { GatewayRequestHandlers } from "./types.js";

function invalidParams(method: string) {
  return errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${method} params`);
}

function schedulerRecoveryError(retryAfterMs: number) {
  return errorShape(ErrorCodes.UNAVAILABLE, "gateway scheduler recovery is pending", {
    retryable: true,
    retryAfterMs,
    details: { reason: "scheduler-resume-failed" },
  });
}

function logDraining(
  result: GatewaySuspendPrepareResult | GatewaySuspendStatusResult,
  log: GatewayRequestContext["logGateway"],
): void {
  if (result.status === "draining") {
    log.info(
      `DRAINING activeCount=${result.activeCount} blockers=${result.blockers.map(({ kind, count }) => `${kind}:${count}`).join(",")} holders=${JSON.stringify(result.blockers.map(({ message }) => message))} custody=${result.writeCustody?.some(({ count }) => count > 0) ? "held" : "clear"}`,
    );
  }
}

export const suspendHandlers: GatewayRequestHandlers = {
  "gateway.suspend.handoff": ({ respond, params, context }) => {
    if (!validateGatewaySuspendHandoffParams(params)) {
      respond(false, undefined, invalidParams("gateway.suspend.handoff"));
      return;
    }
    if (
      params.target.pid !== process.pid ||
      params.target.processInstanceId !== getGatewayProcessInstanceId()
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "gateway process changed after preflight"),
      );
      return;
    }
    const owner = context.hostLifecycle?.externalRestart;
    if (!owner) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "gateway host does not own process exit"),
      );
      return;
    }
    const result = armGatewaySuspendHandoff({
      suspensionId: params.suspensionId.trim(),
      owner,
      commit: params.commit,
    });
    if (!result.ok) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, result.error));
      return;
    }
    respond(true, result.value);
  },
  "gateway.suspend.reader": (options) => {
    const { respond, params, context } = options;
    if (!validateGatewaySuspendReaderParams(params)) {
      respond(false, undefined, invalidParams("gateway.suspend.reader"));
      return;
    }
    if (
      params.target.pid !== process.pid ||
      params.target.processInstanceId !== getGatewayProcessInstanceId()
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "gateway process changed after preflight"),
      );
      return;
    }
    const owner = context.hostLifecycle?.externalRestart;
    if (!owner?.prepareReader) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "gateway host does not support irreversible reader retirement",
        ),
      );
      return;
    }
    const assertCurrent = readGatewayRequestMutationAuthority(options).assertCurrent;
    // The router releases preparation before invocation. Native custody then
    // outlives this nonblocking request while retaining its authenticated reply.
    void prepareGatewaySuspendedReader({
      suspensionId: params.suspensionId.trim(),
      request: { target: params.target, expiresAtMs: params.expiresAtMs },
      owner,
      assertCurrent,
    })
      .then((receipt) => {
        assertCurrent();
        respond(true, receipt);
      })
      .catch((error: unknown) =>
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            error instanceof Error ? error.message : "Gateway reader retirement failed",
          ),
        ),
      );
  },
  "gateway.suspend.prepare": async (options) => {
    const { respond, params, context } = options;
    if (!validateGatewaySuspendPrepareParams(params)) {
      respond(false, undefined, invalidParams("gateway.suspend.prepare"));
      return;
    }
    const requestId = params.requestId.trim();
    const authority = readGatewayRequestMutationAuthority(options);
    authority.assertCurrent();
    const result = await prepareGatewaySuspend({
      requestId,
      assertCurrent: authority.assertCurrent,
      terminalPolicy: params.terminalPolicy ?? "preserve",
      ...(params.drain === true ? { drain: true } : {}),
      pauseScheduling: () => context.cron.pauseScheduling(),
      resumeScheduling: () => context.cron.resumeScheduling(),
      inspect: createGatewayServerActiveWorkInspectors(context),
      beforeDrain: async (assertCurrent) => {
        const resolver = context.resolveGatewayContext;
        if (!resolver || resolver() !== context) {
          throw new Error("Gateway suspension capture requires its current host context.");
        }
        const { markRestartAbortedMainSessions } =
          await import("../../agents/main-session-recovery/main-session-restart-recovery-marking.js");
        const { captureGatewayRestartRecoveryRuns } = await import("../server-run-shutdown.js");
        await markRestartAbortedMainSessions({
          resolveGatewayContext: resolver,
          cfg: context.getRuntimeConfig(),
          ...captureGatewayRestartRecoveryRuns({ ...context, acceptedOnly: true }),
          captureGoals: true,
          assertCommitAllowed: () => {
            authority.assertCurrent();
            assertCurrent();
            if (resolver() !== context) {
              throw new Error("Gateway host changed during restart intent capture");
            }
          },
        });
      },
      warn: (message) => context.logGateway.warn(message),
    });
    authority.assertCurrent();
    if (result.status === "conflict") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "another gateway suspension is already prepared", {
          retryable: true,
          retryAfterMs: Math.max(0, result.expiresAtMs - Date.now()),
          details: { reason: "gateway-suspension-conflict", expiresAtMs: result.expiresAtMs },
        }),
      );
      return;
    }
    if (result.status === "recovering") {
      respond(false, undefined, schedulerRecoveryError(result.retryAfterMs));
      return;
    }
    logDraining(result, context.logGateway);
    respond(true, result);
  },
  "gateway.suspend.status": async ({ respond, params, context }) => {
    if (!validateGatewaySuspendStatusParams(params)) {
      respond(false, undefined, invalidParams("gateway.suspend.status"));
      return;
    }
    const suspensionId = params.suspensionId.trim();
    const result = getGatewaySuspendStatus(suspensionId, params.includeLifecycle === true);
    if (result.status === "conflict") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "a different gateway suspension is prepared", {
          retryable: true,
          retryAfterMs: Math.max(0, result.expiresAtMs - Date.now()),
          details: { reason: "gateway-suspension-conflict", expiresAtMs: result.expiresAtMs },
        }),
      );
      return;
    }
    if (result.status === "recovering") {
      respond(false, undefined, schedulerRecoveryError(result.retryAfterMs));
      return;
    }
    logDraining(result, context.logGateway);
    respond(true, result);
  },
  "gateway.suspend.resume": async ({ respond, params }) => {
    if (!validateGatewaySuspendResumeParams(params)) {
      respond(false, undefined, invalidParams("gateway.suspend.resume"));
      return;
    }
    const suspensionId = params.suspensionId.trim();
    const result = resumeGatewaySuspend(suspensionId);
    if (!result.ok) {
      if (result.reason === "gateway-restarting") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "gateway shutdown is committed"),
        );
        return;
      }
      if (result.reason === "scheduler-resume-failed") {
        respond(false, undefined, schedulerRecoveryError(result.retryAfterMs));
        return;
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "gateway suspension id does not match"),
      );
      return;
    }
    respond(true, result);
  },
};
