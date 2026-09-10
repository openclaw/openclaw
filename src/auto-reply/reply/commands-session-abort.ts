// Implements session abort commands and active-run stop targeting.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import {
  resolveAbortCutoffFromContext,
  shouldPersistAbortCutoff,
  type AbortCutoff,
} from "./abort-cutoff.js";
import {
  abortSessionRunTargetWithOutcome,
  formatAbortReplyText,
  isAbortTrigger,
  setAbortMemory,
  stopSubagentsForRequester,
} from "./abort.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import {
  persistAbortTargetEntry,
  resolveCommandSessionEntryForKey,
} from "./commands-session-store.js";
import type { CommandHandler } from "./commands-types.js";
import { clearSessionQueues } from "./queue.js";
import { replyRunRegistry } from "./reply-run-registry.js";
import { readChannelSourceTurnId } from "./source-turn-id.js";

type AbortTarget = {
  entry?: SessionEntry;
  key?: string;
  sessionId?: string;
};

function resolveAbortTarget(params: {
  ctx: { CommandTargetSessionKey?: string | null };
  sessionKey?: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
}): AbortTarget {
  const targetSessionKey =
    normalizeOptionalString(params.ctx.CommandTargetSessionKey) || params.sessionKey;
  const resolved = resolveCommandSessionEntryForKey(params.sessionStore, targetSessionKey);
  const entry =
    resolved.entry ??
    (targetSessionKey && targetSessionKey === params.sessionKey ? params.sessionEntry : undefined);
  const key = resolved.key ?? targetSessionKey;
  return {
    entry,
    key,
    sessionId: (key ? replyRunRegistry.resolveSessionId(key) : undefined) ?? entry?.sessionId,
  };
}

function resolveAbortCutoffForTarget(params: {
  ctx: Parameters<CommandHandler>[0]["ctx"];
  commandSessionKey?: string;
  targetSessionKey?: string;
}): AbortCutoff | undefined {
  if (
    !shouldPersistAbortCutoff({
      commandSessionKey: params.commandSessionKey,
      targetSessionKey: params.targetSessionKey,
    })
  ) {
    return undefined;
  }
  return resolveAbortCutoffFromContext(params.ctx);
}

async function applyAbortTarget(params: {
  isCurrent?: () => boolean;
  clearQueues?: boolean;
  abortTarget: AbortTarget;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  abortKey?: string;
  abortCutoff?: AbortCutoff;
}) {
  const { abortTarget } = params;
  if (params.isCurrent?.() === false) {
    throw new Error("The selected session changed before it could be stopped.");
  }
  if (params.clearQueues) {
    const cleared = clearSessionQueues([abortTarget.key, abortTarget.sessionId]);
    if (cleared.followupCleared > 0 || cleared.laneCleared > 0) {
      logVerbose(
        `stop: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`,
      );
    }
  }
  const abortOutcome = abortSessionRunTargetWithOutcome({
    key: abortTarget.key,
    sessionId: abortTarget.sessionId,
  });
  if (abortOutcome.active && !abortOutcome.aborted) {
    return abortOutcome;
  }

  const persisted = await persistAbortTargetEntry({
    isCurrent: params.isCurrent,
    entry: abortTarget.entry,
    key: abortTarget.key,
    sessionStore: params.sessionStore,
    storePath: params.storePath,
    abortCutoff: params.abortCutoff,
  });
  if (!persisted && params.abortKey && params.isCurrent?.() !== false) {
    setAbortMemory(params.abortKey, true);
  }
  return abortOutcome;
}

function buildAbortTargetApplyParams(
  params: Parameters<CommandHandler>[0],
  abortTarget: AbortTarget,
) {
  return {
    isCurrent: params.opts?.isCommandTargetCurrent,
    abortTarget,
    sessionStore: params.sessionStore,
    storePath: params.storePath,
    abortKey: params.command.abortKey,
    abortCutoff: resolveAbortCutoffForTarget({
      ctx: params.ctx,
      commandSessionKey: params.sessionKey,
      targetSessionKey: abortTarget.key,
    }),
  };
}

/** Preserve the ordinary abort target while also revoking durable task custody.
 * Only a host-owned channel input identity can address this conversation. */
function stopSupervisedTarget(params: Parameters<CommandHandler>[0], target: AbortTarget) {
  const { key: sessionKey, sessionId } = target;
  const inputId =
    readChannelSourceTurnId(params.ctx) ??
    (params.rootCtx ? readChannelSourceTurnId(params.rootCtx) : undefined);
  if (
    !inputId ||
    !sessionKey ||
    !sessionId ||
    !params.command.senderIsOwner ||
    params.opts?.isHeartbeat ||
    (params.ctx.InputProvenance && params.ctx.InputProvenance.kind !== "external_user")
  ) {
    return undefined;
  }
  return Promise.all([
    import("../../tasks/supervised-task.admission.js"),
    import("../../tasks/supervised-task.root-source.js"),
    import("../../gateway/session-utils.js"),
  ]).then(
    async ([
      { maybeAdmitSupervisedRootTask },
      { bindSupervisedRootSource },
      { loadGatewaySessionEntryReadOnly },
    ]) => {
      const assertCurrent = () => {
        params.commandInvocationSignal?.throwIfAborted();
        params.opts?.abortSignal?.throwIfAborted();
        if (params.opts?.isCommandTargetCurrent?.() === false) {
          throw new Error("Stop target changed before task cancellation");
        }
        const current = loadGatewaySessionEntryReadOnly(sessionKey, { agentId: params.agentId });
        if (
          !current.entry ||
          current.entry.sessionId !== sessionId ||
          current.entry.archivedAt !== undefined
        ) {
          throw new Error("Stop target changed before task cancellation");
        }
      };
      assertCurrent();
      const result = await maybeAdmitSupervisedRootTask({
        config: params.cfg,
        source: bindSupervisedRootSource({
          config: params.cfg,
          agentId: params.agentId,
          sessionKey,
          sessionId,
          namespace: "channel",
          inputId,
        }),
        message: params.command.commandBodyNormalized,
        model: `${params.provider}/${params.model}`,
        ownerAuthorized: true,
        internal: false,
        assertCurrent,
      });
      if (result.kind === "admitted") {
        throw new Error("Stop cannot admit new work");
      }
      return result.kind === "handled" ? result.message : undefined;
    },
  );
}

// Task custody is optional, but its cancellation failure must be visible without
// disabling the ordinary run and child-stop path.
function tryStopSupervisedTarget(params: Parameters<CommandHandler>[0], target: AbortTarget) {
  return stopSupervisedTarget(params, target)?.catch(
    () =>
      "Supervised task cancellation could not be confirmed; it may still be running. Retry /stop or inspect Tasks.",
  );
}

export const handleStopCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/stop") {
    return null;
  }
  const unauthorizedStop = rejectUnauthorizedCommand(params, "/stop");
  if (unauthorizedStop) {
    return unauthorizedStop;
  }
  const abortTarget = resolveAbortTarget({
    ctx: params.ctx,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
  });
  const supervisedStop = tryStopSupervisedTarget(params, abortTarget);
  const supervised = supervisedStop ? await supervisedStop : undefined;
  let abortOutcome = { active: false, aborted: false };
  // Capture child generations before signalling the parent; cleanup must not discover
  // a replacement conversation's children after the original publisher finishes.
  const { stopped, failed } = await stopSubagentsForRequester({
    cfg: params.cfg,
    requesterSessionKey: abortTarget.key ?? params.sessionKey,
    requesterAgentId: params.agentId,
    beforeKill: async () => {
      abortOutcome = await applyAbortTarget({
        ...buildAbortTargetApplyParams(params, abortTarget),
        clearQueues: true,
      });

      // Trigger internal hook for stop command
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
  return {
    shouldContinue: false,
    reply: {
      text: [formatAbortReplyText(stopped, rejectionReason, failed), supervised]
        .filter(Boolean)
        .join("\n"),
    },
  };
};

export const handleAbortTrigger: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (!isAbortTrigger(params.command.rawBodyNormalized)) {
    return null;
  }
  const unauthorizedAbortTrigger = rejectUnauthorizedCommand(params, "abort trigger");
  if (unauthorizedAbortTrigger) {
    return unauthorizedAbortTrigger;
  }
  const abortTarget = resolveAbortTarget({
    ctx: params.ctx,
    sessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    sessionStore: params.sessionStore,
  });
  const supervisedStop = tryStopSupervisedTarget(params, abortTarget);
  const supervised = supervisedStop ? await supervisedStop : undefined;
  const abortOutcome = await applyAbortTarget(buildAbortTargetApplyParams(params, abortTarget));
  const rejectionReason =
    abortOutcome.active && !abortOutcome.aborted ? ("finalizing" as const) : undefined;
  return {
    shouldContinue: false,
    reply: {
      text: [formatAbortReplyText(undefined, rejectionReason), supervised]
        .filter(Boolean)
        .join("\n"),
    },
  };
};
