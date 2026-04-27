import { normalizeDeviceMetadataForAuth } from "./device-metadata-normalization.js";
export { normalizeDeviceMetadataForAuth };
export function buildDeviceAuthPayload(params) {
    const scopes = params.scopes.join(",");
    const token = params.token ?? "";
    return [
        "v2",
        params.deviceId,
        params.clientId,
        params.clientMode,
        params.role,
        scopes,
        String(params.signedAtMs),
        token,
        params.nonce,
    ].join("|");
}
export function buildDeviceAuthPayloadV3(params) {
    const scopes = params.scopes.join(",");
    const token = params.token ?? "";
    const platform = normalizeDeviceMetadataForAuth(params.platform);
    const deviceFamily = normalizeDeviceMetadataForAuth(params.deviceFamily);
    return [
        "v3",
        params.deviceId,
        params.clientId,
        params.clientMode,
        params.role,
        scopes,
        String(params.signedAtMs),
        token,
        params.nonce,
        platform,
        deviceFamily,
    ].join("|");
}
