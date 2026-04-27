let auditDeepModulePromise;
async function loadAuditDeepModule() {
    auditDeepModulePromise ??= import("./audit.deep.runtime.js");
    return await auditDeepModulePromise;
}
export async function collectDeepCodeSafetyFindings(params) {
    if (!params.deep) {
        return [];
    }
    const auditDeep = await loadAuditDeepModule();
    return [
        ...(await auditDeep.collectPluginsCodeSafetyFindings({
            stateDir: params.stateDir,
            summaryCache: params.summaryCache,
        })),
        ...(await auditDeep.collectInstalledSkillsCodeSafetyFindings({
            cfg: params.cfg,
            stateDir: params.stateDir,
            summaryCache: params.summaryCache,
        })),
    ];
}
