import { isCommandFlagEnabled } from "../../config/commands.js";
import { logVerbose } from "../../globals.js";
export function rejectUnauthorizedCommand(params, commandLabel) {
    if (params.command.isAuthorizedSender) {
        return null;
    }
    logVerbose(`Ignoring ${commandLabel} from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
    return { shouldContinue: false };
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
