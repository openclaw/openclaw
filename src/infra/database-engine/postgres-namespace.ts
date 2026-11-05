// Store names are quoted SQL identifiers; Team Reports retains its native hyphen.
// Keep anchors and recovery manifests on the same restricted naming contract.
export const postgresNamespacePattern = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
