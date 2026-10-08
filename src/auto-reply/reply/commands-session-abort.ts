// Implements session abort commands and active-run stop targeting.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveAbortCutoffFromContext, shouldPersistAbortCutoff } from "./abort-cutoff.js";
import { prepareSessionRunTargetAbort, stopSubagentsForRequester } from "./abort-operation.js";
import { isAbortTrigger } from "./abort-trigger-text.js";
import { formatAbortReplyText } from "./abort.js";
import { commandReply, defineAuthorizedTextCommand } from "./command-gates.js";
import {
  persistAbortTargetEntry,
  resolveCommandSessionEntryForKey,
} from "./commands-session-store.js";
import type { CommandHandler } from "./commands-types.js";
import { prepareSessionLifecycleQueueCleanup } from "./queue/cleanup.js";
import { resolveReplyOperationsForSession } from "./reply-run-registry.js";

type AbortTarget = {
  agentId: string;
  entry?: SessionEntry;
  key?: string;
  sessionId?: string;
};

function resolveAbortTarget(params: Parameters<CommandHandler>[0]): AbortTarget {
  const targetSessionKey =
    normalizeOptionalString(params.ctx.CommandTargetSessionKey) || params.sessionKey;
  const resolved = resolveCommandSessionEntryForKey(params.sessionStore, targetSessionKey);
  const entry =
    resolved.entry ??
    (targetSessionKey && targetSessionKey === params.sessionKey ? params.sessionEntry : undefined);
  const key = resolved.key ?? targetSessionKey;
  const agentId = resolveSessionAgentId({
    config: params.cfg,
    sessionKey: key,
    fallbackAgentId: params.agentId,
  });
  return {
    agentId,
    entry: entry ? { ...entry } : undefined,
    key,
    sessionId:
      (key
        ? resolveReplyOperationsForSession({ sessionKeys: [key], agentId })[0]?.sessionId
        : undefined) ?? entry?.sessionId,
  };
}

async function applyAbortTarget(
  params: Parameters<CommandHandler>[0],
  abortTarget: AbortTarget,
  abort: ReturnType<typeof prepareSessionRunTargetAbort>,
  clearQueues?: ReturnType<typeof prepareSessionLifecycleQueueCleanup>,
  acceptedRetirements?: Promise<void>[],
) {
  const { sessionStore, storePath } = params;
  const isCurrent = params.opts?.isCommandTargetCurrent;
  const abortCutoff = shouldPersistAbortCutoff({
    commandSessionKey: params.sessionKey,
    targetSessionKey: abortTarget.key,
  })
    ? resolveAbortCutoffFromContext(params.ctx)
    : undefined;
  const assertCurrent = () => {
    if (isCurrent?.() === false) {
      throw new Error("The selected session changed before it could be stopped.");
    }
  };
  assertCurrent();
  if (clearQueues) {
    const cleared = clearQueues();
    if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
      logVerbose(
        `stop: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
      );
    }
  }
  const abortOutcome = abort();
  if (abortOutcome.aborted && abortOutcome.retirement && acceptedRetirements) {
    // Accepted parent cleanup joins after selected descendants have been signalled.
    void abortOutcome.retirement.catch(() => {});
    acceptedRetirements.push(abortOutcome.retirement);
  } else {
    await abortOutcome.retirement;
  }
  if (abortOutcome.active && !abortOutcome.aborted) {
    return abortOutcome;
  }
  await persistAbortTargetEntry({
    isCurrent,
    entry: abortTarget.entry,
    key: abortTarget.key,
    sessionStore,
    storePath,
    abortCutoff,
  });
  return abortOutcome;
}

export const handleStopCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: "/stop", match: (body) => (body === "/stop" ? true : null) },
  async (params) => {
    const abortTarget = resolveAbortTarget(params);
    const abort = prepareSessionRunTargetAbort({
      agentId: abortTarget.agentId,
      key: abortTarget.key,
      sessionId: abortTarget.sessionId,
    });
    const clearQueues = abortTarget.key
      ? prepareSessionLifecycleQueueCleanup({
          keys: [abortTarget.key, abortTarget.sessionId],
          agentId: abortTarget.agentId,
          sessionKey: abortTarget.key,
          sessionId: abortTarget.sessionId,
          assertCurrent: () => {
            if (params.opts?.isCommandTargetCurrent?.() === false) {
              throw new Error("The selected session changed before it could be stopped.");
            }
          },
        })
      : undefined;
    let abortOutcome = { active: false, aborted: false };
    const acceptedRetirements: Promise<void>[] = [];
    const failures: unknown[] = [];
    // Capture child generations before signalling the parent; cleanup must not discover
    // a replacement conversation's children after the original publisher finishes.
    const subagents = await stopSubagentsForRequester({
      cfg: params.cfg,
      requesterSessionKey: abortTarget.key ?? params.sessionKey,
      requesterAgentId: params.agentId,
      requesterSession:
        abortTarget.entry && abortTarget.sessionId
          ? {
              storePath: resolveSessionStorePathCore(params.cfg.session?.store, {
                agentId: abortTarget.agentId,
              }),
              sessionId: abortTarget.sessionId,
              lifecycleRevision: abortTarget.entry.lifecycleRevision ?? null,
            }
          : undefined,
      assertCurrent: () => {
        if (params.opts?.isCommandTargetCurrent?.() === false) {
          throw new Error("The selected session changed before it could be stopped.");
        }
      },
      beforeKill: async (sealRootSelection) => {
        sealRootSelection();
        abortOutcome = await applyAbortTarget(
          params,
          abortTarget,
          abort,
          clearQueues,
          acceptedRetirements,
        );

        const hookEvent = createInternalHookEvent(
          "command",
          "stop",
          abortTarget.key ?? params.sessionKey ?? "",
          {
            sessionEntry: abortTarget.entry,
            sessionId: abortTarget.sessionId,
            commandSource: params.command.surface,
            senderId: params.command.senderId,
          },
        );
        await triggerInternalHook(hookEvent);
        return true;
      },
    }).catch((error: unknown) => {
      failures.push(error);
      return undefined;
    });
    await Promise.all(
      acceptedRetirements.map((retirement) =>
        retirement.catch((error: unknown) => {
          failures.push(error);
        }),
      ),
    );
    if (subagents === undefined || failures.length > 0) {
      throw failures.length === 1
        ? failures[0]
        : new AggregateError(failures, failures.map(formatErrorMessage).join("; "));
    }
    const { stopped, failed, execAborted } = subagents;
    const rejectionReason =
      abortOutcome.active && !abortOutcome.aborted && !execAborted
        ? ("finalizing" as const)
        : undefined;
    return commandReply(formatAbortReplyText(stopped, rejectionReason, failed));
  },
);

export const handleAbortTrigger: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "abort trigger",
    match: (_body, params) => (isAbortTrigger(params.command.rawBodyNormalized) ? true : null),
  },
  async (params) => {
    const abortTarget = resolveAbortTarget(params);
    const abortOutcome = await applyAbortTarget(
      params,
      abortTarget,
      prepareSessionRunTargetAbort({
        agentId: abortTarget.agentId,
        key: abortTarget.key,
        sessionId: abortTarget.sessionId,
      }),
    );
    const rejectionReason =
      abortOutcome.active && !abortOutcome.aborted ? ("finalizing" as const) : undefined;
    return commandReply(formatAbortReplyText(undefined, rejectionReason));
  },
);
