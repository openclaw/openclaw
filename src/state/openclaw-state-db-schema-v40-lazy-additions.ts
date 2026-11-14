/** Exact pre-bootstrap source layout; this first-use column did not bump the version. */
export function withLegacyWorkspaceBootstrapDeferred(schema: string): string {
  return schema.replace("  bootstrap_deferred INTEGER,\n", "");
}

/** Both additions followed v39; predecessor admission must not inherit either one. */
export function withLegacyStateV40Additions(schema: string): string {
  return withLegacyWorkspaceBootstrapDeferred(schema).replace(
    /CREATE TABLE IF NOT EXISTS device_pairing_browser_requests \([\s\S]*?\) STRICT;\n\n/u,
    "",
  );
}
