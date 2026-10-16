import path from "node:path";
import {
  DAEMON_RUNTIME_PIN_SCHEMA_VERSION,
  resolveDaemonRuntimePinStorePath,
} from "../daemon/runtime-pin-store.js";
import type { OpenClawSchemaVersions } from "../state/openclaw-schema-versions.js";
import type { UpdateStateSchemaVersion } from "./update-candidate-state.js";

export function resolveUpdateStateContentVersion(entry: UpdateStateSchemaVersion): number | null {
  return entry.contentVersion ?? entry.userVersion;
}

export function updateStateSchemaVersionsMatch(
  before: readonly UpdateStateSchemaVersion[],
  after: readonly UpdateStateSchemaVersion[],
  params: { sharedPath: string; candidateSchemaVersions?: OpenClawSchemaVersions },
): boolean {
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
    // An older baseline cannot name the new, still absent local store.
    const legacyOmission = versions.get(daemonPath) === null && !baseline.has(daemonPath);
    return (
      before.length + Number(legacyOmission) === after.length &&
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
          : entry.path === daemonPath
            ? DAEMON_RUNTIME_PIN_SCHEMA_VERSION
            : candidate.agent;
      return baseline.get(entry.path) == null && version === supported;
    })
  );
}
