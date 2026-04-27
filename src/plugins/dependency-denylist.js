const BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAMES = ["plain-crypto-js"];
export const blockedInstallDependencyPackageNames = [
    ...BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAMES,
];
const BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAME_SET = new Set(blockedInstallDependencyPackageNames);
const BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAME_LOWER_SET = new Set(blockedInstallDependencyPackageNames.map((packageName) => packageName.toLowerCase()));
function isBlockedInstallDependencyPackageName(packageName) {
    return BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAME_SET.has(packageName);
}
function isBlockedInstallDependencyPackagePathName(packageName) {
    return BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAME_LOWER_SET.has(packageName.toLowerCase());
}
function normalizePathSegments(relativePath) {
    return relativePath
        .split(/[\\/]+/)
        .map((segment) => segment.trim())
        .filter(Boolean);
}
function parseBlockedNodeModulesPackageId(segments, packageNameSegmentTransform) {
    for (let index = 0; index < segments.length; index += 1) {
        if (segments[index]?.toLowerCase() !== "node_modules") {
            continue;
        }
        const packageScopeOrName = segments[index + 1];
        if (!packageScopeOrName) {
            continue;
        }
        if (packageScopeOrName.startsWith("@")) {
            const packageNameSegment = segments[index + 2];
            if (!packageNameSegment) {
                continue;
            }
            const packageName = packageNameSegmentTransform(packageNameSegment);
            if (!packageName) {
                continue;
            }
            const scopedPackageId = `${packageScopeOrName}/${packageName}`;
            if (!isBlockedInstallDependencyPackagePathName(scopedPackageId)) {
                continue;
            }
            return scopedPackageId;
        }
        const packageName = packageNameSegmentTransform(packageScopeOrName);
        if (!packageName || !isBlockedInstallDependencyPackagePathName(packageName)) {
            continue;
        }
        return packageName;
    }
    return undefined;
}
function parseNpmAliasTargetPackageName(spec) {
    const normalized = spec.trim();
    if (!normalized.startsWith("npm:")) {
        return undefined;
    }
    const aliasTarget = normalized.slice("npm:".length).trim();
    if (!aliasTarget) {
        return undefined;
    }
    if (aliasTarget.startsWith("@")) {
        const slashIndex = aliasTarget.indexOf("/");
        if (slashIndex < 0) {
            return undefined;
        }
        const versionSeparatorIndex = aliasTarget.indexOf("@", slashIndex + 1);
        return versionSeparatorIndex < 0 ? aliasTarget : aliasTarget.slice(0, versionSeparatorIndex);
    }
    const versionSeparatorIndex = aliasTarget.indexOf("@");
    return versionSeparatorIndex < 0 ? aliasTarget : aliasTarget.slice(0, versionSeparatorIndex);
}
function parsePackageNameFromOverrideSelector(selector) {
    const normalized = selector.trim();
    if (!normalized || normalized === ".") {
        return undefined;
    }
    if (normalized.startsWith("@")) {
        const slashIndex = normalized.indexOf("/");
        if (slashIndex < 0) {
            return undefined;
        }
        const versionSeparatorIndex = normalized.indexOf("@", slashIndex + 1);
        return versionSeparatorIndex < 0 ? normalized : normalized.slice(0, versionSeparatorIndex);
    }
    const versionSeparatorIndex = normalized.indexOf("@");
    return versionSeparatorIndex < 0 ? normalized : normalized.slice(0, versionSeparatorIndex);
}
function collectBlockedOverrideFindings(value, path = []) {
    if (typeof value === "string") {
        const aliasTargetPackageName = parseNpmAliasTargetPackageName(value);
        if (!aliasTargetPackageName) {
            return [];
        }
        if (!BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAME_SET.has(aliasTargetPackageName)) {
            return [];
        }
        return [
            {
                dependencyName: aliasTargetPackageName,
                declaredAs: path.join(" > "),
                field: "overrides",
            },
        ];
    }
    const findings = [];
    for (const overrideKey of Object.keys(value).toSorted()) {
        const overrideSelectorPackageName = parsePackageNameFromOverrideSelector(overrideKey);
        if (overrideSelectorPackageName &&
            BLOCKED_INSTALL_DEPENDENCY_PACKAGE_NAME_SET.has(overrideSelectorPackageName)) {
            findings.push({
                dependencyName: overrideSelectorPackageName,
                declaredAs: [...path, overrideKey].join(" > "),
                field: "overrides",
            });
        }
        findings.push(...collectBlockedOverrideFindings(value[overrideKey], [...path, overrideKey]));
    }
    return findings;
}
function isPackageOverrideObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function findBlockedManifestDependencies(manifest) {
    const findings = [];
    if (manifest.name && isBlockedInstallDependencyPackageName(manifest.name)) {
        findings.push({ dependencyName: manifest.name, field: "name" });
    }
    if (isPackageOverrideObject(manifest.overrides)) {
        findings.push(...collectBlockedOverrideFindings(manifest.overrides));
    }
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        const dependencyMap = manifest[field];
        if (!dependencyMap) {
            continue;
        }
        for (const dependencyName of Object.keys(dependencyMap).toSorted()) {
            if (isBlockedInstallDependencyPackageName(dependencyName)) {
                findings.push({ dependencyName, field });
                continue;
            }
            const aliasTargetPackageName = parseNpmAliasTargetPackageName(dependencyMap[dependencyName]);
            if (!aliasTargetPackageName) {
                continue;
            }
            if (!isBlockedInstallDependencyPackageName(aliasTargetPackageName)) {
                continue;
            }
            findings.push({
                dependencyName: aliasTargetPackageName,
                declaredAs: dependencyName,
                field,
            });
        }
    }
    return findings;
}
export function findBlockedNodeModulesDirectory(params) {
    const dependencyName = parseBlockedNodeModulesPackageId(normalizePathSegments(params.directoryRelativePath), (packageNameSegment) => packageNameSegment);
    return dependencyName
        ? {
            dependencyName,
            directoryRelativePath: params.directoryRelativePath,
        }
        : undefined;
}
function parseBlockedPackageFileAliasName(fileName) {
    const extensionMatch = /^(.+)\.(js|json|node)$/i.exec(fileName);
    if (extensionMatch) {
        return extensionMatch[1];
    }
    if (fileName.includes(".")) {
        return undefined;
    }
    return fileName;
}
export function findBlockedNodeModulesFileAlias(params) {
    const dependencyName = parseBlockedNodeModulesPackageId(normalizePathSegments(params.fileRelativePath), parseBlockedPackageFileAliasName);
    return dependencyName
        ? {
            dependencyName,
            fileRelativePath: params.fileRelativePath,
        }
        : undefined;
}
export function findBlockedPackageDirectoryInPath(params) {
    const segments = normalizePathSegments(params.pathRelativeToRoot);
    for (let index = 0; index < segments.length; index += 1) {
        const packageScopeOrName = segments[index];
        if (!packageScopeOrName) {
            continue;
        }
        if (packageScopeOrName.startsWith("@")) {
            const packageName = segments[index + 1];
            if (!packageName) {
                continue;
            }
            const scopedPackageId = `${packageScopeOrName}/${packageName}`;
            if (!isBlockedInstallDependencyPackagePathName(scopedPackageId)) {
                index += 1;
                continue;
            }
            return {
                dependencyName: scopedPackageId,
                directoryRelativePath: params.pathRelativeToRoot,
            };
        }
        if (!isBlockedInstallDependencyPackagePathName(packageScopeOrName)) {
            continue;
        }
        return {
            dependencyName: packageScopeOrName,
            directoryRelativePath: params.pathRelativeToRoot,
        };
    }
    return undefined;
}
export function findBlockedPackageFileAliasInPath(params) {
    const segments = normalizePathSegments(params.pathRelativeToRoot);
    const fileName = segments.at(-1);
    if (!fileName) {
        return undefined;
    }
    const dependencyName = parseBlockedPackageFileAliasName(fileName);
    if (!dependencyName || !isBlockedInstallDependencyPackagePathName(dependencyName)) {
        return undefined;
    }
    return {
        dependencyName,
        fileRelativePath: params.pathRelativeToRoot,
    };
}
