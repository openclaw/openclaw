type SetupRegistryRuntimeModule = Pick<typeof import("./setup-registry.js"), "resolvePluginSetupCliBackend">;
type SetupCliBackendRuntimeEntry = {
    pluginId: string;
    backend: {
        id: string;
    };
};
export declare const __testing: {
    resetRuntimeState(): void;
    setRuntimeModuleForTest(module: SetupRegistryRuntimeModule | null | undefined): void;
};
export declare function resolvePluginSetupCliBackendRuntime(params: {
    backend: string;
}): SetupCliBackendRuntimeEntry | undefined;
export {};
