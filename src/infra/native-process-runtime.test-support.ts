import { createTestEntrypoint } from "./runtime-entrypoint.test-support.ts";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.ts";

const entrypoint = createTestEntrypoint(import.meta.url, "infra");

// Native process probes start their deadlines after the invocation owner prepares these modules.
export const nativeProcessTestEntrypoints = {
  acpClient: entrypoint("../acp/client", "acp/client.js"),
  backupDatabaseDiscovery: runtimeProcessEntrypoints.backupDatabaseDiscovery,
  databaseBackup: runtimeProcessEntrypoints.databaseBackup,
  updatePostgresState: runtimeProcessEntrypoints.updatePostgresState,
  tailscale: entrypoint("tailscale"),
  diagnosticsTimeline: entrypoint("diagnostics-timeline"),
  fsSafeCore: entrypoint("fs-safe"),
  fsSafeEnv: entrypoint("fs-safe-env"),
  memoryFsUtils: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "../../packages/memory-host-sdk/src/host/fs-utils",
    distWorkerPath: "test-support/memory-fs-utils.js",
  },
} as const;
