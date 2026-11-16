export function createRuntimeProcessEntrypoint(currentModuleUrl: string) {
  return function runtimeProcessEntrypoint(
    modulePath: string,
    distModulePath = modulePath,
    extension = ".js",
    sourceExtension?: ".ts" | ".mts" | ".mjs",
  ) {
    return {
      currentModuleUrl,
      sourceModulePath: `src/${modulePath}${sourceExtension ?? ".ts"}`,
      sourceExtension,
      sourceWorkerName: modulePath.startsWith("infra/")
        ? modulePath.slice("infra/".length)
        : `../${modulePath}`,
      distWorkerPath: `${distModulePath}${extension}`,
    } as const;
  };
}
