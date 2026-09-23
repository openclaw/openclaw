export type OpenClawSchemaVersions = {
  state: number;
  agent: number;
};

export function parseOpenClawSchemaVersions(value: unknown): OpenClawSchemaVersions | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    !Number.isInteger(record.state) ||
    (record.state as number) < 0 ||
    !Number.isInteger(record.agent) ||
    (record.agent as number) < 0
  ) {
    return undefined;
  }
  return { state: record.state as number, agent: record.agent as number };
}

export function parsePackageOpenClawSchemaVersions(
  packageJson: unknown,
): OpenClawSchemaVersions | undefined {
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    return undefined;
  }
  const manifest = packageJson as Record<string, unknown>;
  const openclaw = manifest.openclaw;
  if (openclaw !== undefined) {
    if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
      return undefined;
    }
    const schemaVersions = (openclaw as Record<string, unknown>).schemaVersions;
    if (schemaVersions !== undefined) {
      return parseOpenClawSchemaVersions(schemaVersions);
    }
  }
  // Published OpenClaw stable releases through 2026.7.1 used schema 1 before
  // declaring it in package metadata. Unknown versions and replacement packages
  // cannot inherit that shipped contract. See database-schemas/integrity-and-recovery.
  if (manifest.name !== "openclaw" || typeof manifest.version !== "string") {
    return undefined;
  }
  const legacy = /^2026\.([1-7])\.([1-9]\d*)$/.exec(manifest.version);
  if (
    !legacy ||
    !Number.isSafeInteger(Number(legacy[2])) ||
    (legacy[1] === "7" && legacy[2] !== "1")
  ) {
    return undefined;
  }
  return { state: 1, agent: 1 };
}
