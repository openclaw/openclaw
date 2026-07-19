// Dispatches chat commands to registered handlers and formats their results.
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { shouldHandleTextCommands } from "../commands-registry.js";
import {
  authorizeCoreCommand,
  resolveCommandAuthorizationDenialText,
  shouldAuthorizeCoreCommandTurn,
} from "./commands-authorization.js";
import { maybeHandleResetCommand } from "./commands-reset.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";
const commandHandlersRuntimeLoader = createLazyImportLoader(
  () => import("./commands-handlers.runtime.js"),
);

function loadCommandHandlersRuntime() {
  return commandHandlersRuntimeLoader.load();
}

let HANDLERS: CommandHandler[] | null = null;

function normalizeCommandHandlerResult(result: CommandHandlerResult): CommandHandlerResult {
  if (!result.reply) {
    return result;
  }
  return {
    ...result,
    reply: {
      ...result.reply,
      replyToId: undefined,
      replyToCurrent: false,
    },
  };
}

export async function handleCommands(params: HandleCommandsParams): Promise<CommandHandlerResult> {
  if (HANDLERS === null) {
    HANDLERS = (await loadCommandHandlersRuntime()).loadCommandHandlers();
  }
  const allowCreateSessionEntry = params.allowCreateSessionEntry === true;
  const initialSessionEntry =
    params.initialSessionEntry ??
    (allowCreateSessionEntry
      ? undefined
      : params.sessionEntry
        ? { ...params.sessionEntry }
        : undefined);
  const commandParams: HandleCommandsParams = {
    ...params,
    initialSessionEntry,
    allowCreateSessionEntry,
  };
  const allowTextCommands = shouldHandleTextCommands({
    cfg: params.cfg,
    surface: params.command.surface,
    commandSource: params.ctx.CommandSource,
  });
  const authorizationCtx = params.rootCtx ?? params.ctx;
  if (
    shouldAuthorizeCoreCommandTurn({
      allowTextCommands,
      commandBodyNormalized: params.command.commandBodyNormalized,
    }) &&
    (params.command.isAuthorizedSender ||
      params.ctx.CommandAuthorized === true ||
      authorizationCtx.TurnAuthority !== undefined)
  ) {
    const authorization = await authorizeCoreCommand({
      command: params.command,
      ctx: authorizationCtx,
      config: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionEntry?.sessionId,
      signal: params.opts?.abortSignal,
    });
    if (authorization.matched && !authorization.allowed) {
      return normalizeCommandHandlerResult({
        shouldContinue: false,
        reply: { text: resolveCommandAuthorizationDenialText(authorization.denial) },
      });
    }
  }
  const resetResult = await maybeHandleResetCommand(commandParams);
  if (resetResult) {
    return normalizeCommandHandlerResult(resetResult);
  }

  for (const handler of HANDLERS) {
    const result = await handler(commandParams, allowTextCommands);
    if (result) {
      return normalizeCommandHandlerResult(result);
    }
  }

  // sendPolicy "deny" is now handled downstream in dispatch-from-config.ts
  // by suppressing outbound delivery while still allowing the agent to process
  // the inbound message (context, memory, tool calls). See #53328.
  return { shouldContinue: true };
}
