import { packNpmSpecToArchive, withTempDir, } from "./install-source-utils.js";
import { resolveNpmIntegrityDriftWithDefaultMessage, } from "./npm-integrity.js";
import { formatPrereleaseResolutionError, isPrereleaseResolutionAllowed, parseRegistryNpmSpec, } from "./npm-registry-spec.js";
export async function installFromNpmSpecArchiveWithInstaller(params) {
    return await installFromNpmSpecArchive({
        tempDirPrefix: params.tempDirPrefix,
        spec: params.spec,
        timeoutMs: params.timeoutMs,
        expectedIntegrity: params.expectedIntegrity,
        onIntegrityDrift: params.onIntegrityDrift,
        warn: params.warn,
        installFromArchive: async ({ archivePath }) => await params.installFromArchive({
            archivePath,
            ...params.archiveInstallParams,
        }),
    });
}
function isSuccessfulInstallResult(result) {
    return result.ok;
}
export function finalizeNpmSpecArchiveInstall(flowResult) {
    if (!flowResult.ok) {
        return flowResult;
    }
    const installResult = flowResult.installResult;
    if (!isSuccessfulInstallResult(installResult)) {
        return installResult;
    }
    const finalized = {
        ...installResult,
        npmResolution: flowResult.npmResolution,
        ...(flowResult.integrityDrift ? { integrityDrift: flowResult.integrityDrift } : {}),
    };
    return finalized;
}
export async function installFromNpmSpecArchive(params) {
    return await withTempDir(params.tempDirPrefix, async (tmpDir) => {
        const parsedSpec = parseRegistryNpmSpec(params.spec);
        if (!parsedSpec) {
            return {
                ok: false,
                error: "unsupported npm spec",
            };
        }
        const packedResult = await packNpmSpecToArchive({
            spec: params.spec,
            timeoutMs: params.timeoutMs,
            cwd: tmpDir,
        });
        if (!packedResult.ok) {
            return packedResult;
        }
        const npmResolution = {
            ...packedResult.metadata,
            resolvedAt: new Date().toISOString(),
        };
        if (npmResolution.version &&
            !isPrereleaseResolutionAllowed({
                spec: parsedSpec,
                resolvedVersion: npmResolution.version,
            })) {
            return {
                ok: false,
                error: formatPrereleaseResolutionError({
                    spec: parsedSpec,
                    resolvedVersion: npmResolution.version,
                }),
            };
        }
        const driftResult = await resolveNpmIntegrityDriftWithDefaultMessage({
            spec: params.spec,
            expectedIntegrity: params.expectedIntegrity,
            resolution: npmResolution,
            onIntegrityDrift: params.onIntegrityDrift,
            warn: params.warn,
        });
        if (driftResult.error) {
            return {
                ok: false,
                error: driftResult.error,
            };
        }
        const installResult = await params.installFromArchive({
            archivePath: packedResult.archivePath,
        });
        return {
            ok: true,
            installResult,
            npmResolution,
            integrityDrift: driftResult.integrityDrift,
        };
    });
}
