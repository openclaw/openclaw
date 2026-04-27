import { normalizeOptionalString } from "../shared/string-coerce.js";
export function resolveGatewayProbeTarget(cfg) {
    const gatewayMode = cfg.gateway?.mode === "remote" ? "remote" : "local";
    const remoteUrlRaw = normalizeOptionalString(cfg.gateway?.remote?.url) ?? "";
    const remoteUrlMissing = gatewayMode === "remote" && !remoteUrlRaw;
    return {
        gatewayMode,
        mode: gatewayMode === "remote" && !remoteUrlMissing ? "remote" : "local",
        remoteUrlMissing,
    };
}
