export type ConfigProvenanceKind =
  | "default"
  | "config"
  | "include"
  | "env"
  | "runtime";

export type ConfigProvenanceEntry = {
  path: string;
  kind: ConfigProvenanceKind;
  applied: boolean;
};

export type ConfigKeySource = {
  keyPath: string;
  sourceKind: ConfigProvenanceKind;
  sourcePath?: string;
};

export type ConfigProvenanceSnapshot = {
  entries: ConfigProvenanceEntry[];
  keySources: ConfigKeySource[];
};

export function createEmptyConfigProvenance(): ConfigProvenanceSnapshot {
  return {
    entries: [],
    keySources: [],
  };
}

export function recordConfigEntry(
  snapshot: ConfigProvenanceSnapshot,
  entry: ConfigProvenanceEntry,
): void {
  snapshot.entries.push(entry);
}

export function recordConfigKeySource(
  snapshot: ConfigProvenanceSnapshot,
  next: ConfigKeySource,
): void {
  const index = snapshot.keySources.findIndex(
    (entry) => entry.keyPath === next.keyPath,
  );
  if (index >= 0) {
    snapshot.keySources[index] = next;
    return;
  }
  snapshot.keySources.push(next);
}

export function getTrackedConfigKeyPaths(): string[] {
  return [
    "gateway.mode",
    "agents.defaults.workspace",
    "agents.defaults.model",
    "agents.defaults.sandbox.mode",
    "plugins.entries",
    "cron.enabled",
    "agents.defaults.heartbeat.every",
  ];
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function hasConfigPath(value: unknown, keyPath: string): boolean {
  const parts = keyPath.split(".").filter(Boolean);
  let current: unknown = value;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return false;
    }
    const record = current as Record<string, unknown>;
    if (!hasOwn(record, part)) {
      return false;
    }
    current = record[part];
  }
  return true;
}
