import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
function resolveNpmPinState(params) {
    if (params.exactVersion) {
        return params.hasIntegrity ? "exact-with-integrity" : "exact-without-integrity";
    }
    return params.hasIntegrity ? "floating-with-integrity" : "floating-without-integrity";
}
function resolveDefaultChoice(value) {
    return value === "npm" || value === "local" ? value : undefined;
}
function normalizeExpectedPackageName(value) {
    const expected = normalizeOptionalString(value);
    if (!expected) {
        return undefined;
    }
    return parseRegistryNpmSpec(expected)?.name ?? expected;
}
export function describePluginInstallSource(install, options) {
    const npmSpec = normalizeOptionalString(install.npmSpec);
    const localPath = normalizeOptionalString(install.localPath);
    const defaultChoice = resolveDefaultChoice(install.defaultChoice);
    const expectedIntegrity = normalizeOptionalString(install.expectedIntegrity);
    const expectedPackageName = normalizeExpectedPackageName(options?.expectedPackageName);
    const warnings = [];
    let npm;
    if (install.defaultChoice !== undefined && !defaultChoice) {
        warnings.push("invalid-default-choice");
    }
    if (npmSpec) {
        const parsed = parseRegistryNpmSpec(npmSpec);
        if (parsed) {
            const exactVersion = parsed.selectorKind === "exact-version";
            const hasIntegrity = Boolean(expectedIntegrity);
            if (!exactVersion) {
                warnings.push("npm-spec-floating");
            }
            if (!hasIntegrity) {
                warnings.push("npm-spec-missing-integrity");
            }
            if (expectedPackageName && parsed.name !== expectedPackageName) {
                warnings.push("npm-spec-package-name-mismatch");
            }
            npm = {
                spec: parsed.raw,
                packageName: parsed.name,
                ...(expectedPackageName && parsed.name !== expectedPackageName
                    ? { expectedPackageName }
                    : {}),
                selectorKind: parsed.selectorKind,
                exactVersion,
                pinState: resolveNpmPinState({ exactVersion, hasIntegrity }),
                ...(parsed.selector ? { selector: parsed.selector } : {}),
                ...(expectedIntegrity ? { expectedIntegrity } : {}),
            };
        }
        else {
            warnings.push("invalid-npm-spec");
        }
    }
    if (defaultChoice === "npm" && !npm) {
        warnings.push("default-choice-missing-source");
    }
    if (defaultChoice === "local" && !localPath) {
        warnings.push("default-choice-missing-source");
    }
    if (expectedIntegrity && !npm) {
        warnings.push("npm-integrity-without-source");
    }
    return {
        ...(defaultChoice ? { defaultChoice } : {}),
        ...(npm ? { npm } : {}),
        ...(localPath ? { local: { path: localPath } } : {}),
        warnings,
    };
}
