// Applies command feature gates before command handlers execute.
import { isCommandFlagEnabled, type CommandFlagKey } from "../../config/commands.flags.js";
import { logVerbose } from "../../globals.js";
import { redactIdentifier } from "../../logging/redact-identifier.js";
import { classifyTurnAuthoritySnapshot } from "../../plugins/turn-authority.js";
import { isNativeCommandTurn, resolveCommandTurnContext } from "../command-turn-context.js";
import type { MsgContext } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import type { CommandHandlerResult, HandleCommandsParams } from "./commands-types.js";

function buildNativeCommandGateReply(text: string): CommandHandlerResult {
  return {
    shouldContinue: false,
    reply: { text },
  };
}

export function rejectUnauthorizedCommand(
  params: HandleCommandsParams,
  commandLabel: string,
): CommandHandlerResult | null {
  if (params.command.isAuthorizedSender) {
    return null;
  }
  logVerbose(
    `Ignoring ${commandLabel} from unauthorized sender: ${redactIdentifier(params.command.senderId)}`,
  );
  if (isNativeCommandTurn(resolveCommandTurnContext(params.ctx))) {
    return buildNativeCommandGateReply("You are not authorized to use this command.");
  }
  return { shouldContinue: false };
}

export function rejectNonOwnerCommand(
  params: HandleCommandsParams,
  commandLabel: string,
): CommandHandlerResult | null {
  if (params.command.senderIsOwner) {
    return null;
  }
  logVerbose(
    `Ignoring ${commandLabel} from non-owner sender: ${redactIdentifier(params.command.senderId)}`,
  );
  if (isNativeCommandTurn(resolveCommandTurnContext(params.ctx))) {
    return buildNativeCommandGateReply("You are not authorized to use this command.");
  }
  return { shouldContinue: false };
}

export function requireGatewayClientScope(
  params: HandleCommandsParams,
  config: {
    label: string;
    allowedScopes: string[];
    missingText: string;
  },
): CommandHandlerResult | null {
  const scopes = resolveGatewayOperatorScopes(params.ctx);
  if (!Array.isArray(scopes)) {
    return null;
  }
  if (config.allowedScopes.some((scope) => scopes.includes(scope))) {
    return null;
  }
  logVerbose(
    `Ignoring ${config.label} from gateway client missing scope: ${config.allowedScopes.join(" or ")}`,
  );
  return {
    shouldContinue: false,
    reply: { text: config.missingText },
  };
}

/** Immutable operator scopes win over mutable compatibility fields. */
export function resolveGatewayOperatorScopes(ctx: MsgContext): string[] | undefined {
  const classifiedAuthority = classifyTurnAuthoritySnapshot(ctx.TurnAuthority);
  if (classifiedAuthority.kind === "invalid") {
    return [];
  }
  if (classifiedAuthority.kind === "issued") {
    const principal = classifiedAuthority.snapshot.authorization.principal;
    return principal.kind === "operator" ? [...principal.scopes] : undefined;
  }
  return Array.isArray(ctx.GatewayClientScopes) ? [...ctx.GatewayClientScopes] : undefined;
}

export function hasGatewayOperatorScope(ctx: MsgContext, scope: string): boolean {
  return resolveGatewayOperatorScopes(ctx)?.includes(scope) === true;
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
