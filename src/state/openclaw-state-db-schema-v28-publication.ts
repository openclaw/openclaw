/** Exact predecessor shape for publication migration admission and PostgreSQL backups. */
export function withLegacyPublicationDraft(schema: string): string {
  return schema.replace(
    /(CREATE TABLE(?: IF NOT EXISTS)? "?github_(?:personal_|repository_)?publication_requests"? \([\s\S]*?)\n {2}(?:"draft" bigint|draft INTEGER),/gu,
    "$1",
  );
}
