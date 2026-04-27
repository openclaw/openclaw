import { isCommandFlagEnabled } from "../../config/commands.flags.js";
import { logVerbose } from "../../globals.js";
import { redactIdentifier } from "../../logging/redact-identifier.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
function buildNativeCommandGateReply(text) {
    return {
        shouldContinue: false,
        reply: { text },
    };
}
export function rejectUnauthorizedCommand(params, commandLabel) {
    if (params.command.isAuthorizedSender) {
        return null;
    }
    logVerbose(`Ignoring ${commandLabel} from unauthorized sender: ${redactIdentifier(params.command.senderId)}`);
    if (params.ctx.CommandSource === "native") {
        return buildNativeCommandGateReply("You are not authorized to use this command.");
    }
    return { shouldContinue: false };
}
export function rejectNonOwnerCommand(params, commandLabel) {
    if (params.command.senderIsOwner) {
        return null;
    }
    logVerbose(`Ignoring ${commandLabel} from non-owner sender: ${redactIdentifier(params.command.senderId)}`);
    if (params.ctx.CommandSource === "native") {
        return buildNativeCommandGateReply("You are not authorized to use this command.");
    }
    return { shouldContinue: false };
}
export function requireGatewayClientScopeForInternalChannel(params, config) {
    if (!isInternalMessageChannel(params.command.channel)) {
        return null;
    }
    const scopes = params.ctx.GatewayClientScopes ?? [];
    if (config.allowedScopes.some((scope) => scopes.includes(scope))) {
        return null;
    }
    logVerbose(`Ignoring ${config.label} from gateway client missing scope: ${config.allowedScopes.join(" or ")}`);
    return {
        shouldContinue: false,
        reply: { text: config.missingText },
    };
}
export function buildDisabledCommandReply(params) {
    const disabledVerb = params.disabledVerb ?? "is";
    const docsSuffix = params.docsUrl ? ` Docs: ${params.docsUrl}` : "";
    return {
        text: `⚠️ ${params.label} ${disabledVerb} disabled. Set commands.${params.configKey}=true to enable.${docsSuffix}`,
    };
}
export function requireCommandFlagEnabled(cfg, params) {
    if (isCommandFlagEnabled(cfg, params.configKey)) {
        return null;
    }
    return {
        shouldContinue: false,
        reply: buildDisabledCommandReply(params),
    };
}
