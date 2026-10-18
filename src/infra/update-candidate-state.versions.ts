import path from "node:path";
import { z } from "zod";
import {
  DAEMON_RUNTIME_PIN_SCHEMA_VERSION,
  resolveDaemonRuntimePinStorePath,
} from "../daemon/runtime-pin-store.js";
import type { OpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import { CLIENT_CREDENTIAL_SCHEMA_VERSION } from "./client-credential-schema.js";
import { resolveClientCredentialStorePath } from "./client-credential-store.js";
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
/** Publish exact aliases; released shared/agent callers opt out of local schema versions. */
export function publishStateDatabaseVersions(
  files: Map<string, StateDatabaseDiscovery>,
  inspected: Map<string, Omit<UpdateStateSchemaVersion, "path">>,
  input: Pick<StateInput, "stateDir" | "includeLocalStoreVersions">,
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
  return input.includeLocalStoreVersions === false
    ? versions.filter(
        ({ path: file }) =>
          file !== resolveClientCredentialStorePath({ OPENCLAW_STATE_DIR: input.stateDir }) &&
          file !== resolveDaemonRuntimePinStorePath({ OPENCLAW_STATE_DIR: input.stateDir }),
      )
    : versions;
}

export function resolveUpdateStateContentVersion(entry: UpdateStateSchemaVersion): number | null {
  return entry.contentVersion ?? entry.userVersion;
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
      const supported =
        entry.path === params.sharedPath
          ? candidate.state
          : entry.path === clientPath
            ? CLIENT_CREDENTIAL_SCHEMA_VERSION
            : entry.path === daemonPath
              ? DAEMON_RUNTIME_PIN_SCHEMA_VERSION
              : candidate.agent;
      return baseline.get(entry.path) == null && version === supported;
    })
  );
}
