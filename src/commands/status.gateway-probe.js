import { resolveGatewayProbeAuthSafeWithSecretInputs, resolveGatewayProbeTarget, } from "../gateway/probe-auth.js";
export { pickGatewaySelfPresence } from "./gateway-presence.js";
export async function resolveGatewayProbeAuthResolution(cfg) {
    const target = resolveGatewayProbeTarget(cfg);
    return resolveGatewayProbeAuthSafeWithSecretInputs({
        cfg,
        mode: target.mode,
        env: process.env,
    });
}
export async function resolveGatewayProbeAuth(cfg) {
    return (await resolveGatewayProbeAuthResolution(cfg)).auth;
}
