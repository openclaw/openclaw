import { isInternalMessageChannel } from "../../utils/message-channel.js";
import { resolveCommandAuthorization } from "../command-auth.js";
export function isResetAuthorizedForContext(params) {
    const auth = resolveCommandAuthorization(params);
    if (!params.commandAuthorized && !auth.isAuthorizedSender) {
        return false;
    }
    const provider = params.ctx.Provider;
    const internalGatewayCaller = provider
        ? isInternalMessageChannel(provider)
        : isInternalMessageChannel(params.ctx.Surface);
    if (!internalGatewayCaller) {
        return true;
    }
    const scopes = params.ctx.GatewayClientScopes;
    if (!Array.isArray(scopes) || scopes.length === 0) {
        return true;
    }
    return scopes.includes("operator.admin");
}
