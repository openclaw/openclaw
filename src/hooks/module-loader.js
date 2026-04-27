import { pathToFileURL } from "node:url";
export function resolveFileModuleUrl(params) {
    const url = pathToFileURL(params.modulePath).href;
    if (!params.cacheBust) {
        return url;
    }
    const ts = params.nowMs ?? Date.now();
    return `${url}?t=${ts}`;
}
export async function importFileModule(params) {
    const specifier = resolveFileModuleUrl(params);
    return (await import(specifier));
}
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic module exports are typed by the caller.
export function resolveFunctionModuleExport(params) {
    const explicitExport = params.exportName?.trim();
    if (explicitExport) {
        const candidate = params.mod[explicitExport];
        return typeof candidate === "function" ? candidate : undefined;
    }
    const fallbacks = params.fallbackExportNames ?? ["default"];
    for (const exportName of fallbacks) {
        const candidate = params.mod[exportName];
        if (typeof candidate === "function") {
            return candidate;
        }
    }
    return undefined;
}
