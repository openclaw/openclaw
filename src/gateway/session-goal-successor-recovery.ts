import { getRegisteredAgentHarness } from "../agents/harness/registry.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../auto-reply/reply/session-event-handoff.js";
import { intersectSessionEventToolsAllow } from "../auto-reply/reply/session-event-target.js";
import {
  isSessionGoalSuccessorCurrent,
  prepareSessionGoalSuccessorExecution,
  retireSessionGoalSuccessor,
} from "../config/sessions/goal-successor.js";
import type { SessionGoalSuccessor } from "../config/sessions/goal-successor.types.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { preparePhysicalSessionStorePath } from "../config/sessions/session-store-path.js";
import { sameSessionTranscriptStorePath } from "../config/sessions/transcript-store-identity.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { restoreGatewayQueuedOperatorRecovery } from "./operator-run-recovery.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { recordRestartResumeFailure } from "./session-restart-resume-failure.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { retainGatewaySessionEntryReadOnly } from "./session-utils-read-lifetime.js";

type Target = { agentId: string; storePath: string; sessionKey: string; env?: NodeJS.ProcessEnv };

/** Startup's existing per-store recovery owner calls this once; no sweep or retry timer. */
type RecoveryParams = {
  context: GatewayRequestContext;
  target: Target;
  successor: SessionGoalSuccessor;
  signal: AbortSignal;
  log: { warn: (message: string) => void };
};

// Idempotency belongs to the existing startup/batch recovery callers, not a new scheduler.
const admissions = new WeakMap<GatewayRequestContext, Map<string, Promise<void>>>();
export function recoverSessionGoalSuccessor(params: RecoveryParams): Promise<void> {
  let owned = admissions.get(params.context);
  if (!owned) {
    owned = new Map();
    admissions.set(params.context, owned);
  }
  const key = JSON.stringify([
    params.target.storePath,
    params.target.sessionKey,
    params.successor.id,
  ]);
  const prior = owned.get(key);
  if (prior) {
    return prior;
  }
  const work = recover(params).then((waiting) => {
    if (waiting) {
      owned.delete(key);
    }
  });
  owned.set(key, work);
  return work;
}

async function recover(params: RecoveryParams): Promise<boolean> {
  const { context, target, successor, signal, log } = params;
  const recovered = await withSessionEntryReadOnlyInWorker(
    target,
    () => signal.throwIfAborted(),
    async (read, owner) => {
      if (!read.ok) {
        throw read.error;
      }
      return { entry: read.value, storePath: owner.source?.path };
    },
  );
  const { entry } = recovered;
  if (entry?.goalSuccessor?.id !== successor.id) {
    return false;
  }
  if (!isSessionGoalSuccessorCurrent(entry, successor)) {
    await retireSessionGoalSuccessor(target, successor, () => signal.throwIfAborted());
    return false;
  }
  // Restored child outbox custody wins. Its committed batch settlement calls this same
  // admission once; startup must not wake an independent parent alongside that owner.
  const { listUnsettledRequesterChildren } =
    await import("../agents/subagents/registry/subagent-registry.js");
  const children = await listUnsettledRequesterChildren({
    requesterSessionKey: target.sessionKey,
    requesterAgentId: target.agentId,
  });
  signal.throwIfAborted();
  if (children.length) {
    return true;
  }
  let retained: Awaited<ReturnType<typeof retainGatewaySessionEntryReadOnly>> | undefined;
  let restored: Awaited<ReturnType<typeof restoreGatewayQueuedOperatorRecovery>> | undefined;
  let continuation: Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>;
  let placement:
    | Awaited<
        ReturnType<
          NonNullable<
            NonNullable<
              GatewayRequestContext["workerSessionPlacementService"]
            >["prepareSessionPlacement"]
          >
        >
      >
    | undefined;
  let sharing: Awaited<
    ReturnType<typeof resolveSessionMutationAuthorizationAsync>
  >["authorization"];
  let assertGoalExecutionCurrent: (() => void) | undefined;
  const release = () => {
    retained?.release();
    restored?.release();
    continuation?.release();
    placement?.release();
    sharing?.release?.();
  };
  const assertCustodyCurrent = () => {
    signal.throwIfAborted();
    assertGoalExecutionCurrent?.();
    if (retained && !retained.isCurrentAtResponse()) {
      throw new Error("Goal successor was stopped, replaced, or lost its session owner.");
    }
    const worker = placement?.current();
    if (
      successor.requiresWorker &&
      placement &&
      (!worker ||
        worker.state === "local" ||
        worker.executionMode !== "remote-exec" ||
        worker.agentId !== target.agentId ||
        worker.sessionKey !== target.sessionKey ||
        worker.sessionId !== successor.sessionId)
    ) {
      throw new Error("Goal successor requires its worker; local fallback is not authorized.");
    }
  };
  const assertCurrent = () => {
    assertCustodyCurrent();
    restored?.authority.assertCurrent();
    sharing?.assertCurrent();
  };
  try {
    if (successor.refusal) {
      throw new Error(successor.refusal);
    }
    const harness = entry.agentHarnessId ?? "openclaw";
    if (harness !== "openclaw" && harness !== "codex") {
      throw new Error(`Goal successor recovery is not supported by harness ${harness}.`);
    }
    retained = await retainGatewaySessionEntryReadOnly(
      target.sessionKey,
      target.agentId,
      (_before, after) =>
        after.goalSuccessor?.id === successor.id && isSessionGoalSuccessorCurrent(after, successor),
      context.getRuntimeConfig(),
      { exactRead: true },
    );
    // Retain the actual routing policy, not a synthetic session.store override: the
    // retained reader compares it with live config at every boundary. Independently
    // fence the actual read sources, not their logical sessions.json locators.
    if (
      !recovered.storePath ||
      !sameSessionTranscriptStorePath(retained.readSource?.path, recovered.storePath) ||
      !isSessionGoalSuccessorCurrent(retained.entry, successor)
    ) {
      throw new Error("Goal destination changed before recovery admission.");
    }
    assertCurrent();
    restored = await restoreGatewayQueuedOperatorRecovery({
      source: successor.source,
      context,
      assertCurrent: assertCustodyCurrent,
    });
    const access = await resolveSessionMutationAuthorizationAsync({
      context,
      client: createSyntheticPluginRuntimeClient({
        operatorRoleActor: { kind: "operator", profileId: restored.authority.profileId },
        operatorRunAuthority: restored.authority,
        scopes: [...restored.authority.scopes],
      }),
      method: "chat.send",
      requestParams: { agentId: target.agentId, sessionKey: target.sessionKey },
      assertInvocationCurrent: assertCustodyCurrent,
    });
    if (access.error) {
      throw new Error(access.error.message);
    }
    sharing = access.authorization;
    if (successor.requiresWorker) {
      placement = await context.workerSessionPlacementService?.prepareSessionPlacement?.(
        successor.sessionId,
      );
      await placement?.prepareRead();
      const current = placement?.current();
      if (
        !current ||
        current.state === "local" ||
        current.executionMode !== "remote-exec" ||
        current.agentId !== target.agentId ||
        current.sessionKey !== target.sessionKey ||
        current.sessionId !== successor.sessionId ||
        getRegisteredAgentHarness(harness)?.harness.cloudPlacement?.mode !== "remote-exec"
      ) {
        throw new Error(
          "Goal worker placement cannot be recovered; restore its worker before resuming.",
        );
      }
    }
    restored.authority.assertCurrent();
    assertCurrent();
    // The occurrence's assertCurrent below retains the receipt/Goal/sharing/placement
    // fences. Accepted successors inherit only this same operator's independently
    // retained policy authority, not the expiring occurrence's Goal assertion.
    continuation = await captureGatewayOperatorRunAuthority({
      client: createSyntheticPluginRuntimeClient({
        operatorRoleActor: { kind: "operator", profileId: restored.authority.profileId },
        operatorRunAuthority: restored.authority,
        scopes: [...restored.authority.scopes],
      }),
      context,
      independentContinuation: true,
    });
    assertCurrent();
    if (!continuation) {
      throw new Error("Goal recovery lost its continuation source authority.");
    }
    const captured = await captureSessionEventTargetForHost(target.agentId, target.sessionKey, {
      env: target.env,
      operatorAuthority: continuation.authority,
      assertCurrent,
      // A known non-owner source must never receive the session principal's fallback.
      requesterOwner: {},
      ...(successor.ownerContinuation ? { ownerContinuation: true as const } : {}),
      producerPolicy: {
        toolsAllow: successor.toolsAllow
          ? intersectSessionEventToolsAllow(...successor.toolsAllow)
          : undefined,
        settings: successor.settings,
      },
    });
    const capturedStorePath = await preparePhysicalSessionStorePath({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      storePath: captured.storePath,
      env: target.env,
    });
    assertCurrent();
    if (
      captured.sessionId !== successor.sessionId ||
      captured.lifecycleRevision !== successor.lifecycleRevision ||
      !sameSessionTranscriptStorePath(capturedStorePath, recovered.storePath)
    ) {
      throw new Error("Goal successor destination changed before recovery.");
    }
    const receipt = withPluginRuntimeGatewayContextResolver(context.resolveGatewayContext, () =>
      enqueueSessionEventForHost(
        "The Gateway restarted during this active goal. Inspect saved work, child results, and external effects before repeating anything, then continue the goal. Do not independently restart children or infer answers to unanswered human decisions.",
        {
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          source: "tool_handoff",
          contextKey: successor.id,
          sourceTurnId: successor.id,
          sourceRunId: successor.sourceRunId,
          expectedTarget: captured,
          deliveryContext: successor.deliveryContext,
          deliver: successor.deliver,
          abortSignal: signal,
          assertCurrent,
          onAdopted: () => prepareSessionGoalSuccessorExecution(target, successor, assertCurrent),
          requiredGoal: {
            identity: {
              sessionId: successor.sessionId,
              lifecycleRevision: successor.lifecycleRevision,
              goalId: successor.goalId,
            },
            onAcquired: (assertExecutionCurrent) => {
              assertCurrent();
              assertExecutionCurrent();
              // Ordinary input adoption is NOT Goal-owner acquisition. Keep the original
              // receipt fenced until the execution owner has retained the exact Goal.
              assertGoalExecutionCurrent = assertExecutionCurrent;
              retained?.release();
              retained = undefined;
            },
          },
        },
      ),
    );
    // Acceptance transfers to the ordinary pending-input owner, but does NOT erase the
    // pursuit receipt: a second crash still needs it until a successor/terminal replaces it.
    const accepted = await receipt.accepted;
    if (!accepted.ok) {
      throw accepted.cause ?? new Error(accepted.error);
    }
    const cleanup = release;
    void receipt.settled
      .then(async (outcome) => {
        if (outcome.status === "failed" && !outcome.interruptedByRestart && !signal.aborted) {
          await recordRestartResumeFailure({
            target,
            entry,
            runId: successor.sourceRunId,
            admissionStage: "goal-successor-execution",
            error: outcome.error ?? "Goal recovery failed",
            signal,
            log,
          });
        }
      })
      .finally(cleanup)
      .catch((error: unknown) => log.warn(`Goal successor settlement failed: ${String(error)}`));
  } catch (error) {
    release();
    signal.throwIfAborted();
    await recordRestartResumeFailure({
      target,
      entry,
      runId: successor.sourceRunId,
      admissionStage: "goal-successor",
      error,
      signal,
      log,
    });
    // A refusal is visible and terminal, never replaced with a broader principal.
    await retireSessionGoalSuccessor(
      target,
      successor,
      () => signal.throwIfAborted(),
      "Goal could not resume after restart. Resolve the reported source or capability error, then Resume.",
    );
  }
  return false;
}
