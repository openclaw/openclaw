import { LEGACY_SECRETREF_ENV_MARKER_PREFIX, parseLegacySecretRefEnvMarker, } from "../config/types.secrets.js";
import { setPathExistingStrict } from "./path-utils.js";
import { discoverConfigSecretTargets, } from "./target-registry.js";
function isLegacySecretRefEnvMarker(value) {
    return typeof value === "string" && value.trim().startsWith(LEGACY_SECRETREF_ENV_MARKER_PREFIX);
}
function toCandidate(target, defaults) {
    if (!isLegacySecretRefEnvMarker(target.value)) {
        return null;
    }
    return {
        path: target.path,
        pathSegments: target.pathSegments,
        value: target.value.trim(),
        ref: parseLegacySecretRefEnvMarker(target.value, defaults?.env),
    };
}
export function collectLegacySecretRefEnvMarkerCandidates(config) {
    const defaults = config.secrets?.defaults;
    return discoverConfigSecretTargets(config)
        .map((target) => toCandidate(target, defaults))
        .filter((candidate) => candidate !== null);
}
export function migrateLegacySecretRefEnvMarkers(config) {
    const candidates = collectLegacySecretRefEnvMarkerCandidates(config).filter((candidate) => candidate.ref !== null);
    if (candidates.length === 0) {
        return { config, changes: [] };
    }
    const next = structuredClone(config);
    const changes = [];
    for (const candidate of candidates) {
        const ref = candidate.ref;
        if (!ref) {
            continue;
        }
        if (setPathExistingStrict(next, candidate.pathSegments, ref)) {
            changes.push(`Moved ${candidate.path} ${LEGACY_SECRETREF_ENV_MARKER_PREFIX}${ref.id} marker → structured env SecretRef.`);
        }
    }
    return { config: next, changes };
}
