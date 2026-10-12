import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginCommandReplyOptions } from "../../plugins/plugin-command-dispatch-contract.js";
import {
  createPluginCommandRuntime,
  matchPluginCommandInvocation,
  PLUGIN_COMMAND_DISPATCH,
} from "../../plugins/plugin-command-runtime.js";
import { isNativeCommandTurn, resolveCommandTurnContext } from "../command-turn-context.js";
import { isExplicitCommandTurnContext } from "../command-turn-detection.js";
import {
  findCommandByNativeName,
  normalizeCommandBody,
  resolveTextCommand,
} from "../commands-registry.js";
import { shouldHandleTextCommands } from "../commands-text-routing.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { resolveCommandChannel } from "./commands-context.js";
import { resolveCommandContextText } from "./context-text.js";

export function shouldBypassPluginOwnedBindingForCommand(
  ctx: FinalizedRuntimeMsgContext,
  cfg: OpenClawConfig,
  replyOptions?: PluginCommandReplyOptions,
): boolean {
  // Command authorization is a trust boundary. Reject malformed runtime context
  // before command-turn normalization can coerce a truthy value.
  if (ctx.CommandAuthorized !== undefined && typeof ctx.CommandAuthorized !== "boolean") {
    return false;
  }
  const commandTurn = resolveCommandTurnContext(ctx);
  if (
    (commandTurn.kind === "native" || commandTurn.kind === "text-slash") &&
    !commandTurn.authorized
  ) {
    return false;
  }
  if (isNativeCommandTurn(commandTurn) && commandTurn.authorized) {
    return true;
  }
  const isAuthorizedTextCommand =
    (commandTurn.kind === "text-slash" && commandTurn.authorized) ||
    (commandTurn.kind === "normal" &&
      typeof ctx.CommandAuthorized === "boolean" &&
      ctx.CommandAuthorized);
  if (
    !isAuthorizedTextCommand ||
    !shouldHandleTextCommands({
      cfg,
      surface: ctx.Surface ?? ctx.Provider ?? "",
      commandSource: ctx.CommandSource,
    })
  ) {
    return false;
  }
  const commandBody = normalizeCommandBody(commandTurn.body ?? resolveCommandContextText(ctx), {
    botUsername: ctx.BotUsername,
  });
  if (!commandBody.startsWith("/")) {
    return false;
  }
  const planned = replyOptions?.[PLUGIN_COMMAND_DISPATCH];
  if (planned) {
    return true;
  }
  const channel = resolveCommandChannel(ctx);
  const match = matchPluginCommandInvocation(createPluginCommandRuntime(), commandBody, {
    channel,
  });
  if (match) {
    if (replyOptions) {
      Object.assign(replyOptions, { [PLUGIN_COMMAND_DISPATCH]: match.dispatch });
    }
    return true;
  }
  if (!isExplicitCommandTurnContext(ctx, cfg)) {
    return false;
  }
  if (resolveTextCommand(commandBody)) {
    return true;
  }
  const provider = normalizeOptionalString(ctx.Provider ?? ctx.Surface);
  return Boolean(
    commandTurn.commandName &&
    findCommandByNativeName(commandTurn.commandName, provider, {
      includeBundledChannelFallback: true,
    }),
  );
}
