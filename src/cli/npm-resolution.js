import { buildNpmResolutionFields, } from "../infra/install-source-utils.js";
export function resolvePinnedNpmSpec(params) {
    const recordSpec = params.pin && params.resolvedSpec ? params.resolvedSpec : params.rawSpec;
    if (!params.pin) {
        return { recordSpec };
    }
    if (!params.resolvedSpec) {
        return {
            recordSpec,
            pinWarning: "Could not resolve exact npm version for --pin; storing original npm spec.",
        };
    }
    return {
        recordSpec,
        pinNotice: `Pinned npm install record to ${params.resolvedSpec}.`,
    };
}
export function mapNpmResolutionMetadata(resolution) {
    return buildNpmResolutionFields(resolution);
}
export function buildNpmInstallRecordFields(params) {
    return {
        source: "npm",
        spec: params.spec,
        installPath: params.installPath,
        version: params.version,
        ...buildNpmResolutionFields(params.resolution),
    };
}
export function resolvePinnedNpmInstallRecord(params) {
    const pinInfo = resolvePinnedNpmSpec({
        rawSpec: params.rawSpec,
        pin: params.pin,
        resolvedSpec: params.resolution?.resolvedSpec,
    });
    logPinnedNpmSpecMessages(pinInfo, params.log, params.warn);
    return buildNpmInstallRecordFields({
        spec: pinInfo.recordSpec,
        installPath: params.installPath,
        version: params.version,
        resolution: params.resolution,
    });
}
export function resolvePinnedNpmInstallRecordForCli(rawSpec, pin, installPath, version, resolution, log, warnFormat) {
    return resolvePinnedNpmInstallRecord({
        rawSpec,
        pin,
        installPath,
        version,
        resolution,
        log,
        warn: (message) => log(warnFormat(message)),
    });
}
export function logPinnedNpmSpecMessages(pinInfo, log, logWarn) {
    if (pinInfo.pinWarning) {
        logWarn(pinInfo.pinWarning);
    }
    if (pinInfo.pinNotice) {
        log(pinInfo.pinNotice);
    }
}
