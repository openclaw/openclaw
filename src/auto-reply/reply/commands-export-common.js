import { resolveDefaultSessionStorePath, resolveSessionFilePath, resolveSessionFilePathOptions, } from "../../config/sessions/paths.js";
import { loadSessionStore } from "../../config/sessions/store.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export function parseExportCommandOutputPath(commandBodyNormalized, aliases) {
    const normalized = commandBodyNormalized.trim();
    if (aliases.some((alias) => normalized === `/${alias}`)) {
        return {};
    }
    const aliasPattern = aliases.map(escapeRegExp).join("|");
    const args = normalized.replace(new RegExp(`^/(${aliasPattern})\\s*`), "").trim();
    const outputPath = args.split(/\s+/).find((part) => !part.startsWith("-"));
    return { outputPath };
}
export function resolveExportCommandSessionTarget(params) {
    const targetAgentId = resolveAgentIdFromSessionKey(params.sessionKey) || params.agentId;
    const storePath = params.storePath ?? resolveDefaultSessionStorePath(targetAgentId);
    const store = loadSessionStore(storePath, { skipCache: true });
    const entry = store[params.sessionKey];
    if (!entry?.sessionId) {
        return { text: `❌ Session not found: ${params.sessionKey}` };
    }
    try {
        const sessionFile = resolveSessionFilePath(entry.sessionId, entry, resolveSessionFilePathOptions({ agentId: targetAgentId, storePath }));
        return { entry, sessionFile };
    }
    catch (err) {
        return {
            text: `❌ Failed to resolve session file: ${formatErrorMessage(err)}`,
        };
    }
}
export function isReplyPayload(value) {
    return "text" in value;
}
