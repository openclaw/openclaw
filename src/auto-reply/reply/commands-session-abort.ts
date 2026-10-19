// Implements session abort commands and active-run stop targeting.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { readChannelContextGatewayContextResolver } from "../../channels/message-access/admission-evidence.js";
import { resolveSessionStorePathCore, type SessionEntry } from "../../config/sessions.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resolveAbortCutoffFromContext, shouldPersistAbortCutoff } from "./abort-cutoff.js";
import {
  abortSessionRunTargetWithOutcome,
  captureChannelSessionStop,
  stopSubagentsForRequester,
} from "./abort-operation.js";
import { completeAbortRetirements } from "./abort-retirements.js";
import { isAbortTrigger } from "./abort-trigger-text.js";
import { formatAbortReplyText } from "./abort.js";
import { commandReply, defineAuthorizedTextCommand } from "./command-gates.js";
import {
  persistAbortTargetEntry,
  resolveCommandSessionEntryForKey,
} from "./commands-session-store.js";
import type { CommandHandler } from "./commands-types.js";

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
    sessionId: entry?.sessionId,
  };
}

function captureAbortTarget(params: Parameters<CommandHandler>[0], abortTarget: AbortTarget) {
  const agentId = resolveSessionAgentId({
    config: params.cfg,
    sessionKey: abortTarget.key ?? params.sessionKey ?? "",
    fallbackAgentId: params.agentId,
  });
  return captureChannelSessionStop({
    key: abortTarget.key,
    sessionId: abortTarget.sessionId,
    agentId,
    resolveGatewayContext:
      readChannelContextGatewayContextResolver(params.rootCtx ?? params.ctx) ??
      getPluginRuntimeGatewayRequestScope()?.resolveGatewayContext,
    storePath:
      params.storePath ?? resolveSessionStorePathCore(params.cfg.session?.store, { agentId }),
  });
}

async function executeChannelUserStop(params: Parameters<CommandHandler>[0]) {
  const abortTarget = resolveAbortTarget(params);
  const capture = captureAbortTarget(params, abortTarget);
  abortTarget.sessionId = capture.sessionId;
  const retirements: Promise<void>[] = [];
  const assertCurrent = () => {
    if (params.opts?.isCommandTargetCurrent?.sessionSource?.assertScopeCurrent) {
      params.opts.isCommandTargetCurrent.sessionSource.assertScopeCurrent();
      return;
    }
    if (params.opts?.isCommandTargetCurrent?.() === false) {
      throw new Error("The selected session changed before it could be stopped.");
    }
  };
  const abortCutoff = shouldPersistAbortCutoff({
    commandSessionKey: params.sessionKey,
    targetSessionKey: abortTarget.key,
  })
    ? resolveAbortCutoffFromContext(params.ctx)
    : undefined;
  const current = params.opts?.isCommandTargetCurrent?.();
  if ((typeof current === "boolean" || current === undefined ? current : await current) === false) {
    throw new Error("The selected session changed before it could be stopped.");
  }
  const stop = abortSessionRunTargetWithOutcome({
    capture,
    retirements,
    assertCurrent,
    hookContext: {
      sessionKey: abortTarget.key ?? params.sessionKey ?? "",
      sessionEntry: abortTarget.entry,
      sessionId: abortTarget.sessionId,
      commandSource: params.command.surface,
      senderId: params.command.senderId,
    },
    messageIdentity: abortCutoff,
    recordAbortTarget: async ({ recordCutoff }) => {
      assertCurrent();
      await persistAbortTargetEntry({
        isCurrent: params.opts?.isCommandTargetCurrent,
        entry: abortTarget.entry,
        key: abortTarget.key,
        sessionStore: params.sessionStore,
        storePath: params.storePath,
        abortCutoff: recordCutoff ? abortCutoff : undefined,
      });
    },
    // The controller invokes this adapter only for sources whose policy stops children.
    stopChildren: (applyParentStop) =>
      stopSubagentsForRequester({
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
        assertCurrent,
        beforeKill: async (sealRootSelection) => {
          sealRootSelection();
          return await applyParentStop();
        },
      }),
  });
  return await completeAbortRetirements(async () => {
    const outcome = await stop.completed;
    return commandReply(
      formatAbortReplyText(
        outcome.childrenStopped,
        outcome.alreadyFinalizing ? "finalizing" : undefined,
        outcome.childFailures,
        outcome.localModelMayStillBeFinishing,
      ),
    );
  }, retirements);
}

export const handleStopCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: "/stop", match: (body) => (body === "/stop" ? true : null) },
  executeChannelUserStop,
);

export const handleAbortTrigger: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "abort trigger",
    match: (_body, params) => (isAbortTrigger(params.command.rawBodyNormalized) ? true : null),
  },
  executeChannelUserStop,
);
