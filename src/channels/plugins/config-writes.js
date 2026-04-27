import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { authorizeConfigWriteShared, canBypassConfigWritePolicyShared, formatConfigWriteDeniedMessageShared, resolveChannelConfigWritesShared, resolveConfigWriteTargetFromPathShared, resolveExplicitConfigWriteTargetShared, } from "./config-write-policy-shared.js";
function isInternalConfigWriteMessageChannel(channel) {
    return normalizeLowercaseStringOrEmpty(channel) === "webchat";
}
export function resolveChannelConfigWrites(params) {
    return resolveChannelConfigWritesShared(params);
}
export function authorizeConfigWrite(params) {
    return authorizeConfigWriteShared(params);
}
export function resolveExplicitConfigWriteTarget(scope) {
    return resolveExplicitConfigWriteTargetShared(scope);
}
export function resolveConfigWriteTargetFromPath(path) {
    return resolveConfigWriteTargetFromPathShared({
        path,
        normalizeChannelId: (raw) => normalizeLowercaseStringOrEmpty(raw),
    });
}
export function canBypassConfigWritePolicy(params) {
    return canBypassConfigWritePolicyShared({
        ...params,
        isInternalMessageChannel: isInternalConfigWriteMessageChannel,
    });
}
export function formatConfigWriteDeniedMessage(params) {
    return formatConfigWriteDeniedMessageShared(params);
}
