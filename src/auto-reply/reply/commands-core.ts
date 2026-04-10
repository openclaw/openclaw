import fs from "node:fs/promises";
import { resetAcpSessionInPlace } from "../../acp/persistent-bindings.js";
import { resolveSessionFilePath, resolveSessionFilePathOptions } from "../../config/sessions.js";
import path from "node:path";
import { resetConfiguredBindingTargetInPlace } from "../../channels/plugins/binding-targets.js";
import { logVerbose } from "../../globals.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import { shouldHandleTextCommands } from "../commands-registry.js";
import { resolveBoundAcpThreadSessionKey } from "./commands-acp/targets.js";
import { handleAllowlistCommand } from "./commands-allowlist.js";
import { handleApproveCommand } from "./commands-approve.js";
import { handleBashCommand } from "./commands-bash.js";
import { handleBtwCommand } from "./commands-btw.js";
import { handleCompactCommand } from "./commands-compact.js";
import { handleConfigCommand, handleDebugCommand } from "./commands-config.js";
import {
  handleCommandsListCommand,
  handleContextCommand,
  handleExportSessionCommand,
  handleHelpCommand,
  handleStatusCommand,
  handleWhoamiCommand,
} from "./commands-info.js";
import { handleLearnCommand, runLearnForSession } from "./commands-learn.js";
import { handleMcpCommand } from "./commands-mcp.js";
import { handleModelsCommand } from "./commands-models.js";
import { handlePluginCommand } from "./commands-plugin.js";
import { handlePluginsCommand } from "./commands-plugins.js";
import {
  handleAbortTrigger,
  handleActivationCommand,
  handleFastCommand,
  handleRestartCommand,
  handleSessionCommand,
  handleSendPolicyCommand,
  handleStopCommand,
  handleUsageCommand,
} from "./commands-session.js";
import { handleSubagentsCommand } from "./commands-subagents.js";
import { handleTtsCommands } from "./commands-tts.js";
import { emitResetCommandHooks } from "./commands-reset-hooks.js";
import { maybeHandleResetCommand } from "./commands-reset.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";
export { emitResetCommandHooks } from "./commands-reset-hooks.js";
let commandHandlersRuntimePromise: Promise<typeof import("./commands-handlers.runtime.js")> | null =
  null;

function loadCommandHandlersRuntime() {
  commandHandlersRuntimePromise ??= import("./commands-handlers.runtime.js");
  return commandHandlersRuntimePromise;
}

let HANDLERS: CommandHandler[] | null = null;

export async function handleCommands(params: HandleCommandsParams): Promise<CommandHandlerResult> {
  if (HANDLERS === null) {
    HANDLERS = [
      // Plugin commands are processed first, before built-in commands
      handlePluginCommand,
      handleBtwCommand,
      handleBashCommand,
      handleActivationCommand,
      handleSendPolicyCommand,
      handleFastCommand,
      handleUsageCommand,
      handleSessionCommand,
      handleRestartCommand,
      handleTtsCommands,
      handleHelpCommand,
      handleCommandsListCommand,
      handleStatusCommand,
      handleAllowlistCommand,
      handleApproveCommand,
      handleContextCommand,
      handleExportSessionCommand,
      handleWhoamiCommand,
      handleSubagentsCommand,
      handleAcpCommand,
      handleMcpCommand,
      handlePluginsCommand,
      handleConfigCommand,
      handleDebugCommand,
      handleModelsCommand,
      handleStopCommand,
      handleCompactCommand,
      handleLearnCommand,
      handleAbortTrigger,
    ];
    HANDLERS = (await loadCommandHandlersRuntime()).loadCommandHandlers();
  }
  const resetMatch = params.command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/);
  const resetRequested = Boolean(resetMatch);
  if (resetRequested && !params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /reset from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  // Trigger internal hook for reset/new commands
  if (resetRequested && params.command.isAuthorizedSender) {
    const commandAction: ResetCommandAction = resetMatch?.[1] === "reset" ? "reset" : "new";
    const resetTail =
      resetMatch != null
        ? params.command.commandBodyNormalized.slice(resetMatch[0].length).trimStart()
        : "";
    const boundAcpSessionKey = resolveBoundAcpThreadSessionKey(params);
    const boundAcpKey =
      boundAcpSessionKey && isAcpSessionKey(boundAcpSessionKey)
        ? boundAcpSessionKey.trim()
        : undefined;

    // Determine which session to learn from (after ACP resolution)
    // For non-ACP resets, use previousSessionEntry because initSessionState already rotated to fresh session
    const targetSessionKey = boundAcpKey ?? params.sessionKey;
    let targetSessionEntry: typeof params.sessionEntry;
    if (boundAcpKey) {
      targetSessionEntry = resolveSessionEntryForHookSessionKey(params.sessionStore, boundAcpKey);
    } else if (params.previousSessionEntry?.sessionId) {
      targetSessionEntry = params.previousSessionEntry;
    } else {
      targetSessionEntry = params.sessionEntry;
    }

    // Trigger learning before reset/new commands (after ACP target resolution)
    // Run in background with dedicated lane to avoid blocking user interactions
    if (targetSessionEntry?.sessionId && targetSessionEntry.sessionFile) {
      const thinkLevel = params.resolvedThinkLevel ?? (await params.resolveDefaultThinkingLevel());
      runLearnForSession({
        sessionId: targetSessionEntry.sessionId,
        sessionKey: targetSessionKey,
        messageChannel: params.command.channel,
        groupId: targetSessionEntry.groupId,
        groupChannel: targetSessionEntry.groupChannel,
        groupSpace: targetSessionEntry.space,
        spawnedBy: targetSessionEntry.spawnedBy,
        sessionFile: targetSessionEntry.sessionFile,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        config: params.cfg,
        skillsSnapshot: targetSessionEntry.skillsSnapshot,
        provider: params.provider,
        model: params.model,
        thinkLevel,
        customFocus:
          "What insights and lessons should be remembered before starting a new session?",
        senderIsOwner: params.command.senderIsOwner,
        ownerNumbers: params.command.ownerList.length > 0 ? params.command.ownerList : undefined,
        lane: "learn",
      }).then((learnResult) => {
        if (learnResult.ok) {
          logVerbose(`Background pre-reset learning completed for session ${targetSessionKey}`);
        } else {
          logVerbose(
            `Background pre-reset learning failed for session ${targetSessionKey}: ${learnResult.message ?? "unknown error"}`,
          );
        }
      });
    }
    if (boundAcpKey) {
      const resetResult = await resetConfiguredBindingTargetInPlace({
        cfg: params.cfg,
        sessionKey: boundAcpKey,
        reason: commandAction,
      });
      if (!resetResult.ok && !resetResult.skipped) {
        logVerbose(
          `acp reset-in-place failed for ${boundAcpKey}: ${resetResult.error ?? "unknown error"}`,
        );
      }
      if (resetResult.ok) {
        const hookSessionEntry =
          boundAcpKey === params.sessionKey
            ? params.sessionEntry
            : resolveSessionEntryForHookSessionKey(params.sessionStore, boundAcpKey);
        const hookPreviousSessionEntry =
          boundAcpKey === params.sessionKey
            ? params.previousSessionEntry
            : resolveSessionEntryForHookSessionKey(params.sessionStore, boundAcpKey);
        await emitResetCommandHooks({
          action: commandAction,
          ctx: params.ctx,
          cfg: params.cfg,
          command: params.command,
          sessionKey: boundAcpKey,
          sessionEntry: hookSessionEntry,
          previousSessionEntry: hookPreviousSessionEntry,
          workspaceDir: params.workspaceDir,
        });
        if (resetTail) {
          applyAcpResetTailContext(params.ctx, resetTail);
          if (params.rootCtx && params.rootCtx !== params.ctx) {
            applyAcpResetTailContext(params.rootCtx, resetTail);
          }
          return {
            shouldContinue: false,
          };
        }
        return {
          shouldContinue: false,
          reply: { text: "✅ ACP session reset in place." },
        };
      }
      if (resetResult.skipped) {
        return {
          shouldContinue: false,
          reply: {
            text: "⚠️ ACP session reset unavailable for this bound conversation. Rebind with /acp bind or /acp spawn.",
          },
        };
      }
      return {
        shouldContinue: false,
        reply: {
          text: "⚠️ ACP session reset failed. Check /acp status and try again.",
        },
      };
    }
    await emitResetCommandHooks({
      action: commandAction,
      ctx: params.ctx,
      cfg: params.cfg,
      command: params.command,
      sessionKey: params.sessionKey,
      sessionEntry: params.sessionEntry,
      previousSessionEntry: params.previousSessionEntry,
      workspaceDir: params.workspaceDir,
    });
  const resetResult = await maybeHandleResetCommand(params);
  if (resetResult) {
    return resetResult;
  }

  const allowTextCommands = shouldHandleTextCommands({
    cfg: params.cfg,
    surface: params.command.surface,
    commandSource: params.ctx.CommandSource,
  });

  for (const handler of HANDLERS) {
    const result = await handler(params, allowTextCommands);
    if (result) {
      return result;
    }
  }

  const sendPolicy = resolveSendPolicy({
    cfg: params.cfg,
    entry: params.sessionEntry,
    sessionKey: params.sessionKey,
    channel: params.sessionEntry?.channel ?? params.command.channel,
    chatType: params.sessionEntry?.chatType,
  });
  if (sendPolicy === "deny") {
    logVerbose(`Send blocked by policy for session ${params.sessionKey ?? "unknown"}`);
    return { shouldContinue: false };
  }

  return { shouldContinue: true };
}
