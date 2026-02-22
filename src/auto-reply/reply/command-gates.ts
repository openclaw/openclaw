import type { CommandFlagKey } from "../../config/commands.js";
import { isCommandFlagEnabled } from "../../config/commands.js";
import { logVerbose } from "../../globals.js";
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
