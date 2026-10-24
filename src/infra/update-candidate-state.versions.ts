import path from "node:path";
import { z } from "zod";
import {
  DAEMON_RUNTIME_PIN_SCHEMA_VERSION,
  resolveDaemonRuntimePinStorePath,
} from "../daemon/runtime-pin-store.js";
import type { OpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import { resolveClientCredentialStorePath } from "./client-credential-paths.js";
import { CLIENT_CREDENTIAL_SCHEMA_VERSION } from "./client-credential-schema.js";
import type { StateDatabaseDiscovery } from "./update-candidate-paths.js";
import type { StateInput } from "./update-candidate-state.shared.js";

export const UpdateStateSchemaVersionsSchema = z.array(
  z.object({
    path: z.string(),
    userVersion: z.number().nullable(),
    contentVersion: z.number().optional(),
    retainedAgentPaths: z.array(z.string()).optional(),
  }),
);
export type UpdateStateSchemaVersion = z.infer<typeof UpdateStateSchemaVersionsSchema>[number];
/** Released daemon-aware callers cannot classify the newer client credential family. */
export function publishStateDatabaseVersions(
  files: Map<string, StateDatabaseDiscovery>,
  inspected: Map<string, Omit<UpdateStateSchemaVersion, "path">>,
  input: Pick<
    StateInput,
    "stateDir" | "includeLocalStoreVersions" | "includeClientCredentialStoreVersion"
  >,
): UpdateStateSchemaVersion[] {
  const versions: UpdateStateSchemaVersion[] = [];
  for (const [identity, discovery] of files) {
    const result = inspected.get(identity);
    if (!result) {
      continue;
    }
    for (const spelling of discovery.spellings) {
      versions.push({ path: spelling, ...result });
    }
  }
  const env = { OPENCLAW_STATE_DIR: input.stateDir };
  const clientPath = resolveClientCredentialStorePath(env);
  const daemonPath = resolveDaemonRuntimePinStorePath(env);
  return versions.filter(({ path: file }) => {
    if (file === clientPath) {
      return (
        input.includeLocalStoreVersions !== false &&
        input.includeClientCredentialStoreVersion !== false
      );
    }
    return input.includeLocalStoreVersions !== false || file !== daemonPath;
  });
}

export function resolveUpdateStateContentVersion(entry: UpdateStateSchemaVersion): number | null {
  return entry.contentVersion ?? entry.userVersion;
}

/** Shared, agent, and local stores retain their own independently versioned contracts. */
export function resolveUpdateStateTargetVersion(
  databasePath: string,
  params: { sharedPath: string; candidateSchemaVersions?: OpenClawSchemaVersions },
): number | undefined {
  const env = { OPENCLAW_STATE_DIR: path.dirname(path.dirname(params.sharedPath)) };
  if (databasePath === resolveClientCredentialStorePath(env)) {
    return CLIENT_CREDENTIAL_SCHEMA_VERSION;
  }
  if (databasePath === resolveDaemonRuntimePinStorePath(env)) {
    return DAEMON_RUNTIME_PIN_SCHEMA_VERSION;
  }
  return params.candidateSchemaVersions?.[databasePath === params.sharedPath ? "state" : "agent"];
}

export function updateStateSchemaVersionsMatch(
  before: readonly UpdateStateSchemaVersion[],
  after: readonly UpdateStateSchemaVersion[],
  params: { sharedPath: string; candidateSchemaVersions?: OpenClawSchemaVersions },
): boolean {
  const clientPath = resolveClientCredentialStorePath({
    OPENCLAW_STATE_DIR: path.dirname(path.dirname(params.sharedPath)),
  });
  const daemonPath = resolveDaemonRuntimePinStorePath({
    OPENCLAW_STATE_DIR: path.dirname(path.dirname(params.sharedPath)),
  });
  const versions = new Map(
    after.map((entry) => [entry.path, resolveUpdateStateContentVersion(entry)]),
  );
  const baseline = new Map(
    before.map((entry) => [entry.path, resolveUpdateStateContentVersion(entry)]),
  );
  const candidate = params.candidateSchemaVersions;
  if (!candidate) {
    // An older baseline cannot name new, still absent local stores.
    const legacyOmissions = [clientPath, daemonPath].filter(
      (file) => versions.get(file) === null && !baseline.has(file),
    ).length;
    return (
      before.length + legacyOmissions === after.length &&
      before.every((entry) => versions.get(entry.path) === resolveUpdateStateContentVersion(entry))
    );
  }
  return (
    before.every(
      (entry) =>
        resolveUpdateStateContentVersion(entry) === null ||
        versions.get(entry.path) === resolveUpdateStateContentVersion(entry),
    ) &&
    after.every((entry) => {
      const version = resolveUpdateStateContentVersion(entry);
      if (version === null || baseline.get(entry.path) === version) {
        return true;
      }
      const supported = resolveUpdateStateTargetVersion(entry.path, params);
      return baseline.get(entry.path) == null && version === supported;
    })
  );
}
