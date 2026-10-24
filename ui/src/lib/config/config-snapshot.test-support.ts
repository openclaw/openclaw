export function configSnapshot(
  config: Record<string, unknown>,
  hash = "hash-1",
  raw = JSON.stringify(config),
) {
  return { config, raw, hash, valid: true, issues: [] };
}
