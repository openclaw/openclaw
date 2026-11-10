import { isDeepStrictEqual } from "node:util";
import type { createHeadlessDeadlineScope } from "../agents/code-mode-headless.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { captureCronJobSourceAuthority } from "../cron/active-jobs.js";
import { tryResolveCronJobEffectiveAgentId } from "../cron/agent-id.js";
import type { CronCompletionDeliveryFence } from "../cron/delivery-attempt-fence.js";
import { CronOperatorSourceError } from "../cron/operator-source-error.js";
import { resolveCronOperatorExecutionRevision } from "../cron/service/jobs-tool-policy.js";
import { isCronOperatorSourceParent } from "../cron/session-target.js";
import type { CronJobPatch, CronStoredJob } from "../cron/types.js";
import { isAbortError } from "../infra/abort-signal.js";
import { GatewayDispatchUnavailableError } from "../infra/restart-recovery-errors.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import {
  operatorScopeSatisfied,
  intersectOperatorScopes,
} from "../shared/operator-scope-compat.js";
import { isSameOpenClawIdTunnelPrincipal } from "./openclaw-id/tunnel-principal.js";
import { sourceRolePolicy } from "./operator-role-source-policy.js";
import { decodeGatewayOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import type { RestartRecoveryOperatorSource } from "./operator-run-recovery-source.codec.js";
import { restoreGatewayOperatorSource } from "./operator-run-recovery.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

/** Re-admit a job's captured parent-conversation source, never a session owner or ambient scheduler. */
export async function restoreCronOperatorSource(params: {
  job: CronStoredJob;
  /** Condition/script runners supply the same current Gateway owner explicitly. */
  context?: GatewayRequestContext;
  target?: {
    agentId: string;
    sessionKey: string;
    entry: Pick<InternalSessionEntry, "sessionId" | "lifecycleRevision">;
  };
  signal?: AbortSignal;
  deliveryAttemptFence: CronCompletionDeliveryFence | null;
}) {
  if (!params.job.operatorSource) {
    return undefined;
  }
  let operator: Awaited<ReturnType<typeof restoreGatewayOperatorSource>> | undefined;
  try {
    const captured = params.job.operatorSource;
    const source = decodeGatewayOperatorRecoverySource(captured.source);
    const target =
      params.target ??
      (source.kind === "gateway"
        ? undefined
        : {
            agentId: source.agentId,
            sessionKey: source.sessionKey,
            entry: source,
          });
    const context =
      params.context ?? getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext?.();
    const assertOccurrence = captureCronJobSourceAuthority(params.job.id);
    if (!context || !assertOccurrence || !params.deliveryAttemptFence) {
      throw new Error("Scheduled operator continuation requires its live Gateway occurrence");
    }
    const fence = params.deliveryAttemptFence;
    // An in-session run executes in the captured conversation and must match its
    // incarnation. A child runs in its own session; occurrence admission owns the
    // parent's lifecycle, so a reset parent still rechecks device and grant here.
    const inSession =
      source.kind !== "gateway" && params.job.sessionTarget === `session:${source.sessionKey}`;
    let admitted = false;
    const assertCurrent = () => {
      params.signal?.throwIfAborted();
      // Admission may force-run an already paused job; later disable/remove edits
      // revoke this exact occurrence through its existing cancellation owner.
      assertOccurrence();
      fence.assertCurrent();
      if (admitted) {
        return;
      }
      const current: CronStoredJob | undefined = context.cron.getJob(params.job.id);
      const policy = current?.scheduledToolPolicy;
      if (
        context.resolveGatewayContext?.() !== context ||
        !current ||
        current.operatorSource?.executionRevision !==
          resolveCronOperatorExecutionRevision(current) ||
        tryResolveCronJobEffectiveAgentId(current, context.cron.getDefaultAgentId()) !==
          source.agentId ||
        (target && target.agentId !== source.agentId) ||
        (source.kind !== "gateway" &&
          ((current.payload.kind !== "agentTurn" && !source.snapshot.openclawIdPrincipal) ||
            !(
              (policy?.mode === "account" && policy.ownerSessionKey === source.sessionKey) ||
              (source.snapshot.openclawIdPrincipal &&
                current.schedule.kind === "stream" &&
                current.payload.kind === "command")
            ) ||
            current.owner?.sessionKey !== source.sessionKey ||
            !isCronOperatorSourceParent(current, source.sessionKey) ||
            (inSession &&
              target &&
              (target.sessionKey !== source.sessionKey ||
                target.entry.sessionId !== source.sessionId ||
                target.entry.lifecycleRevision !== source.lifecycleRevision)))) ||
        !isDeepStrictEqual(current.operatorSource, captured)
      ) {
        throw new Error(
          "Scheduled operator continuation definition or conversation changed; recreate it from an authenticated turn",
        );
      }
    };
    assertCurrent();
    operator = await restoreGatewayOperatorSource({
      snapshot: source.snapshot,
      // The restored authority lives as long as the session this run executes in.
      target: target
        ? {
            agentId: target.agentId,
            sessionKey: target.sessionKey,
            sessionId: target.entry.sessionId,
          }
        : undefined,
      context,
      assertCurrent,
    });
    assertCurrent();
    admitted = true;
    return operator;
  } catch (error) {
    operator?.release();
    if (error instanceof GatewayDispatchUnavailableError && error.retryable) {
      throw error;
    }
    // Restart and cancellation end this attempt; they say nothing about the stored source.
    if (params.signal?.aborted || isAbortError(error)) {
      throw error;
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new CronOperatorSourceError(
      `The operator authority that created this automation was refused (device, access grant, role or definition changed); recreate it from an authenticated turn. Cause: ${reason}`,
      { cause: error },
    );
  }
}

/** A headless condition or payload retains its original parent and releases its abort subscription. */
export async function restoreCronScriptOperatorSource(
  job: CronStoredJob,
  context: GatewayRequestContext | undefined,
  scope: ReturnType<typeof createHeadlessDeadlineScope>,
  deliveryAttemptFence: CronCompletionDeliveryFence | null,
) {
  const operator = await scope.wait(
    restoreCronOperatorSource({ job, context, signal: scope.signal, deliveryAttemptFence }),
  );
  if (!operator) {
    return undefined;
  }
  const signal = operator.authority.signal;
  const onRevoked = () => scope.cleanup();
  const release = () => {
    signal?.removeEventListener("abort", onRevoked);
    operator.release();
  };
  try {
    signal?.addEventListener("abort", onRevoked, { once: true });
    operator.authority.assertCurrent();
    return { ...operator, release, [Symbol.dispose]: release };
  } catch (error) {
    release();
    throw error;
  }
}

type CronSourceCapture = {
  operatorSource?: RestartRecoveryOperatorSource;
  assertOperatorSourceCurrent?: () => void;
  disposeOperatorSource?: () => void;
};

/** Timing controls retain the task's requester; they never promote its code to the editing admin. */
export function retainCronControlSource<T extends CronSourceCapture>(params: {
  job: CronStoredJob;
  patch: CronJobPatch;
  capture: T;
  context: GatewayRequestContext;
}): T {
  const previous = params.job.operatorSource;
  const fresh = params.capture.operatorSource;
  if (
    !previous ||
    !fresh ||
    (previous.source.kind !== "gateway" && !previous.source.snapshot.openclawIdPrincipal)
  ) {
    return params.capture;
  }
  // A stream's schedule is its process definition, not timing; enabling it remains a control.
  const processDefinition =
    params.patch.schedule !== undefined &&
    (params.job.schedule.kind === "stream" || params.patch.schedule.kind === "stream");
  const controlOnly =
    !processDefinition &&
    Object.keys(params.patch).every((key) =>
      ["schedule", "enabled", "description", "displayName"].includes(key),
    );
  const sameRequester = previous.source.snapshot.profileId === fresh.snapshot.profileId;
  // Devices share their account's profile, so only the exact device listing that holds the
  // grant may refresh it; another device or a reapproval of the same one keeps the original.
  const sameDevice = isSameOpenClawIdTunnelPrincipal(
    previous.source.snapshot.openclawIdPrincipal,
    fresh.snapshot.openclawIdPrincipal,
  );
  const samePolicy = isDeepStrictEqual(
    sourceRolePolicy(previous.source.snapshot.rolePolicy),
    sourceRolePolicy(fresh.snapshot.rolePolicy),
  );
  if (sameRequester && !controlOnly) {
    // Changing what runs authorizes the new task under the editing device, as recreating it would.
    return params.capture;
  }
  if (sameRequester && sameDevice && samePolicy) {
    // A fresh connection may have broader invocation scopes; a timing edit does not grant them.
    const scopes = intersectOperatorScopes(fresh.snapshot.scopes, previous.source.snapshot.scopes);
    return {
      ...params.capture,
      operatorSource: freezeJsonSnapshot({
        ...fresh,
        snapshot: {
          ...fresh.snapshot,
          scopes,
          controlUiAdmin:
            previous.source.snapshot.controlUiAdmin &&
            fresh.snapshot.controlUiAdmin &&
            operatorScopeSatisfied("operator.admin", scopes),
        },
      }),
      assertOperatorSourceCurrent: () => {
        params.capture.assertOperatorSourceCurrent?.();
        if (
          !isDeepStrictEqual(params.context.cron.getJob(params.job.id)?.operatorSource, previous)
        ) {
          throw new Error("The automation's standing scope changed during the control edit.");
        }
      },
    };
  }
  if (!controlOnly) {
    throw new TypeError(
      "Changing this automation's execution requires its original requester or explicit ownership reauthorization.",
    );
  }
  // Another requester's or device's timing edit keeps the stored grant; each run revalidates it.
  return {
    ...params.capture,
    operatorSource: previous.source,
    assertOperatorSourceCurrent: () => {
      params.capture.assertOperatorSourceCurrent?.();
      if (!isDeepStrictEqual(params.context.cron.getJob(params.job.id)?.operatorSource, previous)) {
        throw new Error("The automation's original source changed during the control edit.");
      }
    },
  };
}
