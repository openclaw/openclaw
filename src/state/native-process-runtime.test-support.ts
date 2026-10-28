import { createTestEntrypoint } from "../infra/runtime-entrypoint.test-support.ts";

const entrypoint = createTestEntrypoint(import.meta.url, "state");

// Native state probes share the invocation's compiled graph before starting child deadlines.
export const stateNativeProcessEntrypoints = {
  localOnboarding: entrypoint("local-onboarding-state.test-support"),
  agentDatabaseCrash: entrypoint("openclaw-agent-db-crash.test-support"),
  canonicalReceipt: entrypoint("openclaw-agent-canonical-validation-receipt.test-support"),
  agentDatabase: entrypoint("openclaw-agent-db"),
  stateDatabase: entrypoint("openclaw-state-db"),
  stateDatabaseCache: entrypoint("openclaw-state-db-cache"),
  stateLease: entrypoint("openclaw-state-lease"),
  loggingState: entrypoint("../logging/state", "logging/state.js"),
  gatewayStateOwner: entrypoint("../infra/gateway-state-owner", "infra/gateway-state-owner.js"),
  sqliteReadOnlyLocation: entrypoint(
    "../infra/sqlite-readonly-location",
    "infra/sqlite-readonly-location.js",
  ),
  nodeSqlite: entrypoint("../infra/node-sqlite", "infra/node-sqlite.js"),
} as const;
