import { readStringValue } from "../shared/string-coerce.js";
export function pickGatewaySelfPresence(presence) {
    if (!Array.isArray(presence)) {
        return null;
    }
    const entries = presence;
    const self = entries.find((e) => e.mode === "gateway" && e.reason === "self") ??
        // Back-compat: older presence payloads only included a `text` line.
        entries.find((e) => typeof e.text === "string" && e.text.startsWith("Gateway:")) ??
        null;
    if (!self) {
        return null;
    }
    return {
        host: readStringValue(self.host),
        ip: readStringValue(self.ip),
        version: readStringValue(self.version),
        platform: readStringValue(self.platform),
    };
}
