import type { Result } from "@openclaw/normalization-core/result";
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
import { captureWorkerInferenceForSession, createChatAbortOps } from "../chat-abort-ops.js";
import { isChatAbortControllerEntryAbortable } from "../chat-abort.js";
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

/** Queued collectors retain scheduler ownership while Gateway admission is still pending. */
export function abortQueuedCollectorSession(
  initialParams: Omit<ChatSessionAbortParams, "ops">,
  prepareSession?: () => Promise<ChatAbortSessionSnapshot>,
): Promise<QueuedCollectorAbortOutcome> | undefined {
  let params = initialParams;
  const entry = getLatestLiveSubagentRunByChildSessionKey(
    params.sessionKey,
    undefined,
    params.agentId,
  );
  if (!entry || !isSubagentRunQueued(entry) || (params.runId && entry.runId !== params.runId)) {
    return undefined;
  }
  let workerCancellation = captureWorkerInferenceForSession({
    context: params.context,
    sessionId: params.sessionId,
  });
  const cfg = params.session?.ok ? params.session.value.cfg : params.context.getRuntimeConfig();
  const parentRunId = entry.requesterTurnRunId;
  const parentRun = parentRunId ? params.context.chatAbortControllers.get(parentRunId) : undefined;
  const parentKey = entry.controllerSessionKey?.trim() || entry.requesterSessionKey;
  const controller = {
    controllerSessionKey: parentKey,
    controllerAgentId: resolveChatRunOwnerAgentId({
      sessionKey: parentKey,
      defaultAgentId: entry.requesterAgentId,
    }),
  };
  // Preserve the actual parent admission's authority through awaited kill work;
  // visibility and operator.write alone do not own an unstarted child.
  const assertCurrent = () => {
    params.assertCurrent?.();
    const current = getCurrentSubagentRunOwner(subagentRuns, entry);
    if (!current || (current.execution.status === "queued" && !isSubagentRunQueued(current))) {
      throw new Error("Queued collector reservation changed; retry Stop.");
    }
    const ownershipError = ensureSubagentControllerOwnsRun({ cfg, controller, entry: current });
    if (ownershipError) {
      throw new Error(ownershipError);
    }
    if (params.requester.isAdmin) {
      return;
    }
    if (
      !parentRunId ||
      !parentRun ||
      params.context.chatAbortControllers.get(parentRunId) !== parentRun ||
      !isChatAbortControllerEntryAbortable(parentRun) ||
      !parentRun.lifecycleGeneration ||
      !isAgentEventLifecycleGenerationCurrent(parentRun.lifecycleGeneration) ||
      parentRun.projectSessionActive === false ||
      resolveSessionStoreKey({
        cfg,
        sessionKey: parentRun.sessionKey,
        storeAgentId: controller.controllerAgentId,
      }) !== parentKey ||
      resolveChatRunOwnerAgentId({
        agentId: parentRun.agentId,
        sessionKey: parentRun.sessionKey,
      }) !== controller.controllerAgentId ||
      !canRequesterAbortChatRun(parentRun, params.requester, { requireOwnerMatch: true })
    ) {
      throw new Error(
        "Unauthorized queued collector Stop; use its active parent requester connection or an administrator.",
      );
    }
  };
  return (async () => {
    let sessionAbort: Result<ReturnType<typeof prepareChatSessionAbort>, ErrorShape> | undefined;
    let outcome: QueuedCollectorAbortOutcome = {
      ok: false,
      error: errorShape(
        ErrorCodes.UNAVAILABLE,
        "Queued collector cancellation was not published; retry Stop.",
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
      assertCurrent();
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
          !sessionAbort ||
          (sessionAbort.ok &&
            !sessionAbort.value.result.unauthorized &&
            sessionAbort.value.canCascade),
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
            if (sessionAbort && !sessionAbort.ok) {
              outcome = sessionAbort;
              return;
            }
            const selected = sessionAbort?.value;
            if (selected?.result.unauthorized) {
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
            if (selected && !selected.canCascade) {
              // Other owned runs may have stopped, but this collector remains eligible.
              outcome = {
                ok: false,
                error: errorShape(
                  ErrorCodes.UNAVAILABLE,
                  "Queued collector was not stopped; other session work was preserved. Wait for it to finish or cancel it through its owner, then retry.",
                ),
              };
              return;
            }
            const cancelledRunId = getQueuedCollectorCancellationRunId(result);
            const aborted = cancelledRunId !== undefined;
            outcome = {
              ok: true,
              value: {
                aborted: aborted || selected?.result.aborted === true,
                runIds: uniqueStrings([
                  ...(aborted ? [cancelledRunId] : []),
                  ...(selected?.result.runIds ?? []),
                ]),
              },
            };
          },
        },
        {
          assertCurrent,
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
              workerCancellation = captureWorkerInferenceForSession(params);
              prepared = true;
            }));
          },
          preparePublication: publication,
          beforeSessionKill: async () => {
            await params.beforeAbort?.();
            assertCurrent();
            // Resolve Gateway owners under the kill runtime's session fence.
            // Signal them only after this collector's FIFO reservation is held.
            const plan = prepareChatSessionAbort(
              {
                ...params,
                ops: createChatAbortOps(params.context),
                cascadeDescendants: true,
                includeProtectedRuns: params.runId ? true : params.includeProtectedRuns,
              },
              workerCancellation,
              entry.runId,
            );
            if (params.runId && plan.hasOtherWork) {
              sessionAbort = {
                ok: false,
                error: errorShape(
                  ErrorCodes.UNAVAILABLE,
                  "Other work is active in this child session; use a full-session Stop without runId.",
                ),
              };
              return false;
            }
            sessionAbort = {
              ok: true,
              value: plan,
            };
            plan.abort();
            return plan.canCascade;
          },
        },
      );
    } catch (error) {
      failure = { error };
      outcome = {
        ok: false,
        error: errorShapeFromError(ErrorCodes.INVALID_REQUEST, error),
      };
    }
    // Gateway cancellation already consumed these buffers. Preserve their snapshots
    // after later owner failures; the transcript writer still fences the session.
    if (sessionAbort?.ok) {
      try {
        const warning = await sessionAbort.value.finish();
        if (warning) {
          outcome = withQueuedCollectorWarning(outcome, warning);
        }
      } catch (error) {
        if (outcome.ok) {
          throw error;
        }
        throw new AggregateError(
          [failure?.error ?? outcome.error, error],
          "Queued collector cancellation and persistence failed",
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
    const queuedAbort = abortQueuedCollectorSession(params, prepareSession);
    if (queuedAbort) {
      const result = await queuedAbort;
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
