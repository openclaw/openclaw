export function resolveMissingBins(params) {
    const remote = params.hasRemoteBin;
    return params.required.filter((bin) => {
        if (params.hasLocalBin(bin)) {
            return false;
        }
        if (remote?.(bin)) {
            return false;
        }
        return true;
    });
}
export function resolveMissingAnyBins(params) {
    if (params.required.length === 0) {
        return [];
    }
    if (params.required.some((bin) => params.hasLocalBin(bin))) {
        return [];
    }
    if (params.hasRemoteAnyBin?.(params.required)) {
        return [];
    }
    return params.required;
}
export function resolveMissingOs(params) {
    if (params.required.length === 0) {
        return [];
    }
    if (params.required.includes(params.localPlatform)) {
        return [];
    }
    if (params.remotePlatforms?.some((platform) => params.required.includes(platform))) {
        return [];
    }
    return params.required;
}
export function resolveMissingEnv(params) {
    const missing = [];
    for (const envName of params.required) {
        if (params.isSatisfied(envName)) {
            continue;
        }
        missing.push(envName);
    }
    return missing;
}
export function buildConfigChecks(params) {
    return params.required.map((pathStr) => {
        const satisfied = params.isSatisfied(pathStr);
        return { path: pathStr, satisfied };
    });
}
export function evaluateRequirements(params) {
    const missingBins = resolveMissingBins({
        required: params.required.bins,
        hasLocalBin: params.hasLocalBin,
        hasRemoteBin: params.hasRemoteBin,
    });
    const missingAnyBins = resolveMissingAnyBins({
        required: params.required.anyBins,
        hasLocalBin: params.hasLocalBin,
        hasRemoteAnyBin: params.hasRemoteAnyBin,
    });
    const missingOs = resolveMissingOs({
        required: params.required.os,
        localPlatform: params.localPlatform,
        remotePlatforms: params.remotePlatforms,
    });
    const missingEnv = resolveMissingEnv({
        required: params.required.env,
        isSatisfied: params.isEnvSatisfied,
    });
    const configChecks = buildConfigChecks({
        required: params.required.config,
        isSatisfied: params.isConfigSatisfied,
    });
    const missingConfig = configChecks.filter((check) => !check.satisfied).map((check) => check.path);
    const missing = params.always
        ? { bins: [], anyBins: [], env: [], config: [], os: [] }
        : {
            bins: missingBins,
            anyBins: missingAnyBins,
            env: missingEnv,
            config: missingConfig,
            os: missingOs,
        };
    const eligible = params.always ||
        (missing.bins.length === 0 &&
            missing.anyBins.length === 0 &&
            missing.env.length === 0 &&
            missing.config.length === 0 &&
            missing.os.length === 0);
    return { missing, eligible, configChecks };
}
export function evaluateRequirementsFromMetadata(params) {
    const required = {
        bins: params.metadata?.requires?.bins ?? [],
        anyBins: params.metadata?.requires?.anyBins ?? [],
        env: params.metadata?.requires?.env ?? [],
        config: params.metadata?.requires?.config ?? [],
        os: params.metadata?.os ?? [],
    };
    const result = evaluateRequirements({
        always: params.always,
        required,
        hasLocalBin: params.hasLocalBin,
        hasRemoteBin: params.hasRemoteBin,
        hasRemoteAnyBin: params.hasRemoteAnyBin,
        localPlatform: params.localPlatform,
        remotePlatforms: params.remotePlatforms,
        isEnvSatisfied: params.isEnvSatisfied,
        isConfigSatisfied: params.isConfigSatisfied,
    });
    return { required, ...result };
}
export function evaluateRequirementsFromMetadataWithRemote(params) {
    return evaluateRequirementsFromMetadata({
        always: params.always,
        metadata: params.metadata,
        hasLocalBin: params.hasLocalBin,
        hasRemoteBin: params.remote?.hasBin,
        hasRemoteAnyBin: params.remote?.hasAnyBin,
        localPlatform: params.localPlatform,
        remotePlatforms: params.remote?.platforms,
        isEnvSatisfied: params.isEnvSatisfied,
        isConfigSatisfied: params.isConfigSatisfied,
    });
}
