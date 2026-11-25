export function configSnapshot(
  config: Record<string, unknown>,
  hash = "hash-1",
  raw = JSON.stringify(config),
) {
  return { config, raw, hash, valid: true, issues: [] };
}

export function sourceConfigSnapshot(config: object = {}, hash = "hash-1") {
  return {
    config,
    sourceConfig: config,
    raw: JSON.stringify(config),
    hash,
    valid: true,
    issues: [],
  };
}
