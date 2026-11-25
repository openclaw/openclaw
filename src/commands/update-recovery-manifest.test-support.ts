export function createMissingConfigRecoveryManifest(params: {
  runId: string;
  installRoot: string;
  stateDir: string;
  configPath: string | undefined;
  createdAt: string;
}) {
  const { runId, installRoot, stateDir, configPath, createdAt } = params;
  return {
    schemaVersion: 2,
    kind: "update-recovery",
    generation: { kind: "baseline" },
    databases: [],
    runId,
    installRoot,
    stateDir,
    configPath,
    configPaths: [configPath],
    creator: { host: "fixture", pid: 1, startIdentity: "1" },
    drivers: [],
    createdAt,
    roots: [configPath],
    excludedRoots: [],
    protectedPaths: [configPath],
    entries: [{ kind: "missing", sourcePath: configPath, sqlite: false, directory: false }],
  };
}
