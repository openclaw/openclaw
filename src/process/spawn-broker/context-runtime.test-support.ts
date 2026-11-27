// Gateway import hooks require the prepared graph's physical module boundaries.
function entrypoint(sourceWorkerName: string, distWorkerPath: string) {
  return {
    currentModuleUrl: import.meta.url,
    sourceWorkerName,
    distWorkerPath,
  };
}
export const spawnBrokerContextEntrypoints = {
  server: entrypoint("../../gateway/server", "legacy-finalizer/src/gateway/server.js"),
  exec: entrypoint("../exec", "legacy-finalizer/src/process/exec.js"),
  context: entrypoint("context", "legacy-finalizer/src/process/spawn-broker/context.js"),
};
