/**
 * Exact predecessor DDL for native admission and PostgreSQL backup restoration.
 *
 * `device_pairing_browser_requests` is a lazy-additive table, so its introduction did
 * not bump the state schema version. It still edits `openclaw-state-schema.sql`, and
 * every predecessor projection derives from that file — without this transform the
 * edit retires the generated catalog entries for every real database left on the
 * previous layout, including databases that never installed the table.
 */
export function withLegacyDevicePairingBrowserRequests(schema: string): string {
  return schema.replace(
    /CREATE TABLE IF NOT EXISTS device_pairing_browser_requests \([\s\S]*?\) STRICT;\n\n/u,
    "",
  );
}
