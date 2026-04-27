import { trimToUndefined } from "./credentials.js";
export function hasExplicitGatewayConnectionAuth(auth) {
    return Boolean(trimToUndefined(auth?.token) || trimToUndefined(auth?.password));
}
export function canSkipGatewayConfigLoad(params) {
    return (!params.config &&
        Boolean(trimToUndefined(params.urlOverride)) &&
        hasExplicitGatewayConnectionAuth(params.explicitAuth));
}
export function isGatewayConfigBypassCommandPath(commandPath) {
    return commandPath[0] === "cron";
}
