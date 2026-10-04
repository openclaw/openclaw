// Implements session abort commands and active-run stop targeting.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { SessionEntry } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { resolveAbortCutoffFromContext, shouldPersistAbortCutoff } from "./abort-cutoff.js";
import { abortSessionRunTargetWithOutcome, stopSubagentsForRequester } from "./abort-operation.js";
import { setAbortMemory } from "./abort-primitives.js";
import { isAbortTrigger } from "./abort-trigger-text.js";
import { formatAbortReplyText } from "./abort.js";
import { commandReply, defineAuthorizedTextCommand } from "./command-gates.js";
import {
  persistAbortTargetEntry,
  resolveCommandSessionEntryForKey,
} from "./commands-session-store.js";
import type { CommandHandler } from "./commands-types.js";
import { clearSessionLifecycleQueues } from "./queue/cleanup.js";
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
    entry,
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
  clearQueues = false,
) {
  const {
    sessionStore,
    storePath,
    command: { abortKey },
  } = params;
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
  if (clearQueues && abortTarget.key) {
    const cleared = clearSessionLifecycleQueues({
      keys: [abortTarget.key, abortTarget.sessionId],
      agentId: abortTarget.agentId,
      sessionKey: abortTarget.key,
      sessionId: abortTarget.sessionId,
      assertCurrent,
    });
    if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
      logVerbose(
        `stop: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
      );
    }
  }
  const abortOutcome = abortSessionRunTargetWithOutcome({
    agentId: abortTarget.agentId,
    key: abortTarget.key,
    sessionId: abortTarget.sessionId,
  });
  if (abortOutcome.active && !abortOutcome.aborted) {
    return abortOutcome;
  }

  await abortOutcome.retirement;
  const persisted = await persistAbortTargetEntry({
    isCurrent,
    entry: abortTarget.entry,
    key: abortTarget.key,
    sessionStore,
    storePath,
    abortCutoff,
  });
  if (!persisted && abortKey && isCurrent?.() !== false) {
    setAbortMemory(abortKey, true);
  }
  return abortOutcome;
}

export const handleStopCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: "/stop", match: (body) => (body === "/stop" ? true : null) },
  async (params) => {
    const abortTarget = resolveAbortTarget(params);
    let abortOutcome = { active: false, aborted: false };
    // Capture child generations before signalling the parent; cleanup must not discover
    // a replacement conversation's children after the original publisher finishes.
    const { stopped, failed } = await stopSubagentsForRequester({
      cfg: params.cfg,
      requesterSessionKey: abortTarget.key ?? params.sessionKey,
      requesterAgentId: params.agentId,
      beforeKill: async () => {
        abortOutcome = await applyAbortTarget(params, abortTarget, true);

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
    });

    const rejectionReason =
      abortOutcome.active && !abortOutcome.aborted ? ("finalizing" as const) : undefined;
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
    const abortOutcome = await applyAbortTarget(params, abortTarget);
    const rejectionReason =
      abortOutcome.active && !abortOutcome.aborted ? ("finalizing" as const) : undefined;
    return commandReply(formatAbortReplyText(undefined, rejectionReason));
  },
);
