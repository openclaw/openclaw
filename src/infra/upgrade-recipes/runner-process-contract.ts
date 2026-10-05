import type { runtimeProcessEntrypoints } from "../runtime-process-entrypoints.js";
// Target Doctor/finalization/maintenance workers are launched from authenticated target artifacts,
// not copied from this retained predecessor runner. These are the independent owner's workers.
export const upgradeRecipeRunnerProcessNames = [
  "sqliteReadOnly",
  "sharedStateStore",
  "sqliteStore",
  "sqliteSnapshotStaging",
  "sqliteReadOnlyNativeResource",
  "sqliteSourceRevision",
  "sqliteIntegrity",
  "updateCandidateState",
  "stateOwnership",
  "stateLeaseHeartbeat",
  "gatewayStateOwnerHeartbeat",
  "fsSafeCopy",
  "spawnBroker",
  "databaseVerify",
  "agentSchemaInspection",
  "stateMigrationSnapshot",
] as const satisfies readonly (keyof typeof runtimeProcessEntrypoints)[];
