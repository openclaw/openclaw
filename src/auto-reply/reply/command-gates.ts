import type { CommandFlagKey } from "../../config/commands.js";
import { isCommandFlagEnabled } from "../../config/commands.js";
import { logVerbose } from "../../globals.js";
import { hasPermission } from "../../rbac/index.js";
import type { ReplyPayload } from "../types.js";
import type { CommandHandlerResult, HandleCommandsParams } from "./commands-types.js";

export function rejectUnauthorizedCommand(
  params: HandleCommandsParams,
  commandLabel: string,
): CommandHandlerResult | null {
  if (params.command.isAuthorizedSender) {
    return null;
  }
  logVerbose(
    `Ignoring ${commandLabel} from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
  );
  return { shouldContinue: false };
}

/**
 * Gate that blocks commands requiring the `commands.admin` permission.
 * Returns a result (blocking the command) when the sender is not an admin;
 * returns null when the sender is allowed to proceed.
 */
export function rejectNonAdminCommand(
  params: HandleCommandsParams,
  commandLabel: string,
): CommandHandlerResult | null {
  if (hasPermission(params.command.role, "commands.admin")) {
    return null;
  }
  logVerbose(
    `Blocking admin-only ${commandLabel} from role="${params.command.role}" sender: ${params.command.senderId || "<unknown>"}`,
  );
  return {
    shouldContinue: false,
    reply: { text: `⛔ ${commandLabel} requires admin access.` },
  };
}

/**
 * Gate that blocks guest users from running ANY slash command.
 * The "guest" role contract is "AI only, no commands" — guests may only
 * send messages and receive AI replies.
 * Returns a result (blocking the command) when the sender is a guest;
 * returns null when the sender is allowed to proceed.
 */
export function rejectGuestCommand(
  params: HandleCommandsParams,
  commandLabel: string,
): CommandHandlerResult | null {
  if (params.command.role !== "guest") {
    return null;
  }
  logVerbose(
    `Blocking ${commandLabel} from guest sender: ${params.command.senderId || "<unknown>"}`,
  );
  return {
    shouldContinue: false,
    reply: { text: `⛔ Commands are not available for guest users.` },
  };
}

export function buildDisabledCommandReply(params: {
  label: string;
  configKey: CommandFlagKey;
  disabledVerb?: "is" | "are";
  docsUrl?: string;
}): ReplyPayload {
  const disabledVerb = params.disabledVerb ?? "is";
  const docsSuffix = params.docsUrl ? ` Docs: ${params.docsUrl}` : "";
  return {
    text: `⚠️ ${params.label} ${disabledVerb} disabled. Set commands.${params.configKey}=true to enable.${docsSuffix}`,
  };
}

export function requireCommandFlagEnabled(
  cfg: { commands?: unknown } | undefined,
  params: {
    label: string;
    configKey: CommandFlagKey;
    disabledVerb?: "is" | "are";
    docsUrl?: string;
  },
): CommandHandlerResult | null {
  if (isCommandFlagEnabled(cfg, params.configKey)) {
    return null;
  }
  return {
    shouldContinue: false,
    reply: buildDisabledCommandReply(params),
  };
}
