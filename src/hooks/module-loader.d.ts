type ModuleNamespace = Record<string, unknown>;
type GenericFunction = (...args: never[]) => unknown;
export declare function resolveFileModuleUrl(params: {
    modulePath: string;
    cacheBust?: boolean;
    nowMs?: number;
}): string;
export declare function importFileModule(params: {
    modulePath: string;
    cacheBust?: boolean;
    nowMs?: number;
}): Promise<ModuleNamespace>;
export declare function resolveFunctionModuleExport<T extends GenericFunction>(params: {
    mod: ModuleNamespace;
    exportName?: string;
    fallbackExportNames?: string[];
}): T | undefined;
export {};
