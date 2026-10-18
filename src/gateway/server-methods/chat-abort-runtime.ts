import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import { killSubagentRunAdmin } from "../../agents/subagents/registry/subagent-control-kill.js";
import { ensureSubagentControllerOwnsRun } from "../../agents/subagents/registry/subagent-control-scope.js";
import {
  getCurrentSubagentRunOwner,
  subagentRuns,
} from "../../agents/subagents/registry/subagent-registry-memory.js";
import {
  getLatestLiveSubagentRunByChildSessionKey,
  isSubagentRunQueued,
} from "../../agents/subagents/registry/subagent-registry-read.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import {
  getRpcSourceForGateway,
  getRpcSourceIdentity,
  getRpcSourceLifecycleGeneration,
  getRpcSourceProjectSessionActive,
  isRpcSourceRegistered,
} from "../../sessions/session-controller.rpc-sources.js";
import { captureWorkerInferenceForSession, createChatAbortOps } from "../chat-abort-ops.js";
import { resolveChatRunOwnerAgentId } from "../chat-run-owner.js";
import { errorShapeFromError } from "../error-shape.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { resolveSessionStoreKey } from "../session-utils.js";
import { canRequesterAbortChatRun } from "./chat-abort-authorization.js";
import { abortControlledSubagents } from "./chat-abort-descendants.js";
import {
  createQueuedCollectorPublication,
  getQueuedCollectorCancellationRunId,
} from "./chat-abort-queued-collector-publication.js";
import type { ChatSessionAbortParams, ChatSessionAbortResult } from "./chat-abort-runtime.types.js";
import { prepareChatSessionAbort } from "./chat-abort-session-plan.js";
import {
  settleChatAbortPersistence,
  withQueuedCollectorWarning,
  type QueuedCollectorAbortOutcome,
  type ChatAbortSessionSnapshot,
} from "./chat-aborted-partial.js";

export { abortControlledSubagents, descendantAbortError } from "./chat-abort-descendants.js";

/** Stops registry-owned work that has no active executor to reach through ordinary abort. */
export function abortDormantSubagentSession(
  initialParams: Omit<ChatSessionAbortParams, "ops">,
  prepareSession?: () => Promise<ChatAbortSessionSnapshot>,
): Promise<QueuedCollectorAbortOutcome> | undefined {
  let params = initialParams;
  const entry = getLatestLiveSubagentRunByChildSessionKey(
    params.sessionKey,
    undefined,
    params.agentId,
  );
  if (
    !entry ||
    (!isSubagentRunQueued(entry) && entry.pauseReason !== "sessions_yield") ||
    (params.runId && entry.runId !== params.runId)
  ) {
    return undefined;
  }
  const cfg = params.session?.ok
    ? params.session.value.cfg
    : (params.context.getRuntimeConfig() ?? {});
  // The dormant child does not grant cancellation authority. Capture its live
  // parent source and carry that exact requester claim through the awaited kill.
  const parentRunId = entry.requesterTurnRunId;
  const capturedParent = parentRunId
    ? getRpcSourceForGateway(parentRunId, params.context.resolveGatewayContext)
    : undefined;
  const parentSource =
    capturedParent &&
    (entry.requesterStorePath === undefined ||
      capturedParent.input.target?.storeScope === entry.requesterStorePath)
      ? capturedParent
      : undefined;
  const parentKey = entry.controllerSessionKey?.trim() || entry.requesterSessionKey;
  const controller = {
    controllerSessionKey: parentKey,
    controllerAgentId: resolveChatRunOwnerAgentId({
      sessionKey: parentKey,
      defaultAgentId: entry.requesterAgentId,
    }),
  };
  const assertCurrent = () => {
    params.assertCurrent?.();
    // Registry generation and controller scope protect the child obligation;
    // the source checks below independently protect its parent requester.
    const current = getCurrentSubagentRunOwner(subagentRuns, entry);
    if (!current || (current.execution.status === "queued" && !isSubagentRunQueued(current))) {
      throw new Error("Dormant subagent obligation changed; retry Stop.");
    }
    const ownershipError = ensureSubagentControllerOwnsRun({ cfg, controller, entry: current });
    if (ownershipError) {
      throw new Error(ownershipError);
    }
    if (params.requester.isAdmin) {
      return;
    }
    const parentIdentity = parentSource && getRpcSourceIdentity(parentSource);
    const parentLifecycleGeneration = parentSource && getRpcSourceLifecycleGeneration(parentSource);
    if (
      !parentRunId ||
      !parentSource ||
      !parentIdentity ||
      !isRpcSourceRegistered(parentSource) ||
      parentSource.input.phase === "consumed" ||
      parentSource.input.retirementRequested ||
      parentSource.input.custody.cancellationRetired ||
      parentSource.input.abortSignal.aborted ||
      !parentLifecycleGeneration ||
      !isAgentEventLifecycleGenerationCurrent(parentLifecycleGeneration) ||
      getRpcSourceProjectSessionActive(parentSource) === false ||
      resolveSessionStoreKey({
        cfg,
        sessionKey: parentIdentity.sessionKey,
        storeAgentId: controller.controllerAgentId,
      }) !== parentKey ||
      resolveChatRunOwnerAgentId(parentIdentity) !== controller.controllerAgentId ||
      !canRequesterAbortChatRun(
        { ...parentIdentity, requester: parentSource.adapter.requester },
        params.requester,
        { requireOwnerMatch: true },
      )
    ) {
      throw new Error(
        "Unauthorized dormant subagent Stop; use its active parent requester connection or an administrator.",
      );
    }
  };
  return (async () => {
    let plan: ReturnType<typeof prepareChatSessionAbort> | undefined;
    let blocked: ErrorShape | undefined;
    let outcome: QueuedCollectorAbortOutcome = {
      ok: false,
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        "Dormant subagent cancellation was not published; retry Stop.",
      ),
    };
    let failure: { error: unknown } | undefined;
    try {
      assertCurrent();
      const projection = getSessionRowProjection(params.context);
      if (projection) {
        do {
          await projection.ensureMaterialized();
        } while (projection.needsMaterialization);
      }
      const publication = createQueuedCollectorPublication({
        context: params.context,
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        get sessionId() {
          return params.sessionId;
        },
        defaultAgentId: params.defaultAgentId,
        projection,
        canPublish: () =>
          blocked === undefined && (!plan || (!plan.result.unauthorized && plan.canCascade)),
      });
      let prepared = prepareSession === undefined;
      let preparation: Promise<void> | undefined;
      await killSubagentRunAdmin(
        {
          cfg,
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          expectedRunId: entry.runId,
          expectedGeneration: entry.generation,
          expectedOwnerKey: entry.requesterSessionKey,
          onResult: (result) => {
            publication.publishSnapshot(result, true);
            if (blocked) {
              outcome = { ok: false, error: blocked };
              return;
            }
            if (plan?.result.unauthorized) {
              outcome = {
                ok: false,
                error: errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"),
              };
              return;
            }
            if (result.found && result.error) {
              outcome = { ok: false, error: errorShape(ErrorCodes.UNAVAILABLE, result.error) };
              return;
            }
            if (plan && !plan.canCascade) {
              outcome = {
                ok: false,
                error: errorShape(
                  ErrorCodes.UNAVAILABLE,
                  "Dormant subagent was not stopped; other session work was preserved. Wait for it to finish or cancel it through its owner, then retry.",
                ),
              };
              return;
            }
            const cancelledRunId = getQueuedCollectorCancellationRunId(result);
            outcome = {
              ok: true,
              value: {
                aborted: cancelledRunId !== undefined || plan?.result.aborted === true,
                runIds: uniqueStrings([
                  ...(cancelledRunId ? [cancelledRunId] : []),
                  ...(plan?.result.runIds ?? []),
                ]),
              },
            };
          },
        },
        {
          assertCurrent,
          requiredSessionId: params.requiredSessionId,
          prepareRead: () => {
            if (prepared || !prepareSession) {
              return undefined;
            }
            return (preparation ??= prepareSession().then((session) => {
              params = {
                ...params,
                session,
                sessionId: session.ok ? session.value.entry?.sessionId : params.sessionId,
              };
              prepared = true;
            }));
          },
          preparePublication: publication,
          beforeSessionKill: async () => {
            await params.beforeAbort?.();
            assertCurrent();
            plan = prepareChatSessionAbort(
              {
                ...params,
                ops: createChatAbortOps(params.context),
                cascadeDescendants: true,
                includeProtectedRuns: params.runId ? true : params.includeProtectedRuns,
              },
              captureWorkerInferenceForSession({
                context: params.context,
                sessionId: params.sessionId,
              }),
              entry.runId,
            );
            if (params.runId && plan.hasOtherWork) {
              blocked = errorShape(
                ErrorCodes.UNAVAILABLE,
                "Other work is active in this child session; use a full-session Stop.",
              );
              return false;
            }
            plan.abort();
            return plan.canCascade;
          },
        },
      );
    } catch (error) {
      failure = { error };
      outcome = { ok: false, error: errorShapeFromError(ErrorCodes.INVALID_REQUEST, error) };
    }
    if (plan) {
      try {
        const warning = await plan.finish();
        if (warning) {
          outcome = withQueuedCollectorWarning(outcome, warning);
        }
      } catch (error) {
        if (outcome.ok) {
          throw error;
        }
        throw new AggregateError(
          [failure?.error ?? outcome.error, error],
          "Dormant subagent cancellation and persistence failed",
          { cause: error },
        );
      }
    }
    return outcome;
  })();
}

export async function abortChatRunsForSessionKeyWithPartials(
  initialParams: ChatSessionAbortParams,
  prepareSession?: () => Promise<ChatAbortSessionSnapshot>,
): Promise<ChatSessionAbortResult> {
  let params = initialParams;
  if (params.cascadeDescendants) {
    const dormantAbort = abortDormantSubagentSession(params, prepareSession);
    if (dormantAbort) {
      const result = await dormantAbort;
      return result.ok
        ? { ...result.value, unauthorized: false }
        : { aborted: false, runIds: [], unauthorized: false, error: result.error };
    }
  }
  let plan = prepareChatSessionAbort(params, captureWorkerInferenceForSession(params));
  let result = plan.result;
  const prepare = prepareSession
    ? async () => {
        const session = await prepareSession();
        params = {
          ...params,
          session,
          sessionId: session.ok ? session.value.entry?.sessionId : params.sessionId,
        };
        plan = prepareChatSessionAbort(params, captureWorkerInferenceForSession(params));
        result = plan.result;
        return { execCancellation: plan.commands, sessionOrigin: plan.sessionOrigin };
      }
    : undefined;
  let descendants: Awaited<ReturnType<typeof abortControlledSubagents>>;
  let failure: { error: unknown } | undefined;
  try {
    if (params.cascadeDescendants && plan.canCascade) {
      descendants = await abortControlledSubagents({
        cfg: params.session?.ok ? params.session.value.cfg : params.context.getRuntimeConfig(),
        sessionKey: params.sessionKey,
        agentId: params.agentId,
        sessionId: params.sessionId,
        lifecycleRevision: params.session?.ok
          ? params.session.value.entry?.lifecycleRevision
          : undefined,
        execCancellation: plan.commands,
        sessionOrigin: plan.sessionOrigin,
        prepareSelection: prepare ? { acceptsRequest: plan.acceptsRequest, prepare } : undefined,
        assertCurrent: params.assertCurrent,
        beforeKill: async () => {
          await params.beforeAbort?.();
          plan.abort();
          // Parent cancellation observers can replace the conversation before child effects.
          await params.beforeAbort?.();
          return plan.canCascade;
        },
      });
    } else {
      if (prepare) {
        await prepare();
      }
      await params.beforeAbort?.();
      plan.abort();
    }
    if (!result.unauthorized && !result.error) {
      // Observe child-triggered changes before persisting this Stop's own partial output.
      await params.beforeAbort?.();
      params.assertCurrent?.();
      params.onCancellationStarted?.();
    }
  } catch (error) {
    failure = { error };
  }
  // Cancellation consumed these buffers before awaited descendant work could fail.
  const warning = await settleChatAbortPersistence(() => plan.finish(), failure);
  return {
    ...result,
    aborted:
      result.aborted ||
      Boolean(descendants?.killed || descendants?.continuationRetired || descendants?.execAborted),
    descendants,
    ...(warning ? { warning } : {}),
  };
}
