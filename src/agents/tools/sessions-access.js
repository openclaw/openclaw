import { resolveSandboxSessionToolsVisibility, } from "../../plugin-sdk/session-visibility.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-resolution.js";
export { createAgentToAgentPolicy, createSessionVisibilityChecker, createSessionVisibilityGuard, listSpawnedSessionKeys, resolveEffectiveSessionToolsVisibility, resolveSandboxSessionToolsVisibility, resolveSessionToolsVisibility, } from "../../plugin-sdk/session-visibility.js";
export function resolveSandboxedSessionToolContext(params) {
    const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
    const visibility = resolveSandboxSessionToolsVisibility(params.cfg);
    const requesterSessionKey = normalizeOptionalString(params.agentSessionKey);
    const requesterInternalKey = requesterSessionKey
        ? resolveInternalSessionKey({
            key: requesterSessionKey,
            alias,
            mainKey,
        })
        : undefined;
    const effectiveRequesterKey = requesterInternalKey ?? alias;
    const restrictToSpawned = params.sandboxed === true &&
        visibility === "spawned" &&
        !!requesterInternalKey &&
        !isSubagentSessionKey(requesterInternalKey);
    return {
        mainKey,
        alias,
        visibility,
        requesterInternalKey,
        effectiveRequesterKey,
        restrictToSpawned,
    };
}
