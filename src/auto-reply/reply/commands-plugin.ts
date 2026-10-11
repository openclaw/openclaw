/**
 * Plugin Command Handler
 *
 * Handles commands registered by plugins, bypassing the LLM agent.
 * This handler is called before built-in command handlers.
 */

import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { resolveSessionStorePathForScope } from "../../config/sessions/session-store-path.js";
import {
  createPluginCommandRuntime,
  executePluginCommandDispatch,
  matchPluginCommandInvocation,
  PLUGIN_COMMAND_DISPATCH,
  type PluginCommandExecutionReplyOptions,
} from "../../plugins/plugin-command-runtime.js";
import { handleCompactCommand } from "./commands-compact.js";
import { buildPluginCommandContext } from "./commands-context.js";
import type { CommandHandler } from "./commands-types.js";

/**
 * Handle plugin-registered commands.
 * Returns a result if a plugin command was matched and executed,
 * or null to continue to the next handler.
 */
export const handlePluginCommand: CommandHandler = async (params, allowTextCommands) => {
  const { command, cfg, agentId: targetAgentId } = params;
  if (!allowTextCommands) {
    return null;
  }

  const planned = (params.opts as PluginCommandExecutionReplyOptions | undefined)?.[
    PLUGIN_COMMAND_DISPATCH
  ];
  if (planned?.kind === "non-plugin") {
    return null;
  }
  if (!planned && !command.commandBodyNormalized.trim().startsWith("/")) {
    return null;
  }
  const dispatch =
    planned?.kind === "plugin"
      ? planned
      : matchPluginCommandInvocation(createPluginCommandRuntime(), command.commandBodyNormalized, {
          channel: command.channel,
        })?.dispatch;
  if (!dispatch) {
    return null;
  }

  const targetSessionEntry = structuredClone(
    params.sessionStore?.[params.sessionKey] ?? params.sessionEntry,
  );
  const sessionTarget = targetSessionEntry?.sessionId
    ? {
        agentId: targetAgentId,
        sessionId: targetSessionEntry.sessionId,
        sessionKey: params.sessionKey,
        storePath: resolveSessionStorePathForScope({
          agentId: targetAgentId,
          sessionKey: params.sessionKey,
          storePath:
            params.storePath ??
            resolveSessionStorePathCore(cfg.session?.store, { agentId: targetAgentId }),
        }),
      }
    : undefined;

  const result = await executePluginCommandDispatch(dispatch, {
    ...buildPluginCommandContext(params),
    sessionId: targetSessionEntry?.sessionId,
    sessionTarget,
    sessionFile: sessionTarget ? formatSqliteSessionFileMarker(sessionTarget) : undefined,
    authProfileId: targetSessionEntry?.authProfileOverride,
    commandBody: command.commandBodyNormalized,
    ...(sessionTarget
      ? {
          runtimeContext: {
            compactCurrent: async (invocationSignal, assertOwnerCurrent) => {
              if (!params.command.isAuthorizedSender) {
                return { compacted: false, reason: "compaction requires authorization" };
              }
              const compaction = await handleCompactCommand(
                {
                  ...params,
                  command: { ...params.command, commandBodyNormalized: "/compact" },
                  commandInvocationSignal: invocationSignal,
                  compactionSessionEntry: targetSessionEntry,
                  opts: {
                    ...params.opts,
                    abortSignal:
                      invocationSignal && params.opts?.abortSignal
                        ? AbortSignal.any([invocationSignal, params.opts.abortSignal])
                        : (invocationSignal ?? params.opts?.abortSignal),
                  },
                },
                true,
                assertOwnerCurrent,
              );
              return (
                compaction?.sessionCompaction ?? {
                  compacted: false,
                  reason: "compaction unavailable",
                }
              );
            },
          },
        }
      : {}),
  });
  const { continueAgent, ...reply } = result;

  return {
    shouldContinue: continueAgent === true,
    reply: Object.keys(reply).length > 0 ? reply : undefined,
  };
};
