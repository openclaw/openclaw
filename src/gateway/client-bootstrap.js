import { resolveGatewayConnectionAuth } from "./connection-auth.js";
import { buildGatewayConnectionDetailsWithResolvers } from "./connection-details.js";
export function resolveGatewayUrlOverrideSource(urlSource) {
    if (urlSource === "cli --url") {
        return "cli";
    }
    if (urlSource === "env OPENCLAW_GATEWAY_URL") {
        return "env";
    }
    return undefined;
}
export async function resolveGatewayClientBootstrap(params) {
    const connection = buildGatewayConnectionDetailsWithResolvers({
        config: params.config,
        url: params.gatewayUrl,
    });
    const urlOverrideSource = resolveGatewayUrlOverrideSource(connection.urlSource);
    const auth = await resolveGatewayConnectionAuth({
        config: params.config,
        explicitAuth: params.explicitAuth,
        env: params.env ?? process.env,
        urlOverride: urlOverrideSource ? connection.url : undefined,
        urlOverrideSource,
    });
    return {
        url: connection.url,
        urlSource: connection.urlSource,
        auth,
    };
}
