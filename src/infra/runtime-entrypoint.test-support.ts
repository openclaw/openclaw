export function createTestEntrypoint(currentModuleUrl: string, scope: string) {
  return function entrypoint(
    sourceWorkerName: string,
    distWorkerPath = `${scope}/${sourceWorkerName}.js`,
  ) {
    return { currentModuleUrl, sourceWorkerName, distWorkerPath } as const;
  };
}
