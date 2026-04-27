async function loadInstallSecurityScanRuntime() {
    return await import("./install-security-scan.runtime.js");
}
export async function scanBundleInstallSource(params) {
    const { scanBundleInstallSourceRuntime } = await loadInstallSecurityScanRuntime();
    return await scanBundleInstallSourceRuntime(params);
}
export async function scanPackageInstallSource(params) {
    const { scanPackageInstallSourceRuntime } = await loadInstallSecurityScanRuntime();
    return await scanPackageInstallSourceRuntime(params);
}
export async function scanInstalledPackageDependencyTree(params) {
    const { scanInstalledPackageDependencyTreeRuntime } = await loadInstallSecurityScanRuntime();
    return await scanInstalledPackageDependencyTreeRuntime(params);
}
export async function scanFileInstallSource(params) {
    const { scanFileInstallSourceRuntime } = await loadInstallSecurityScanRuntime();
    return await scanFileInstallSourceRuntime(params);
}
export async function scanSkillInstallSource(params) {
    const { scanSkillInstallSourceRuntime } = await loadInstallSecurityScanRuntime();
    return await scanSkillInstallSourceRuntime(params);
}
