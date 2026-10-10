export function clawBootstrapProvenanceFromRow(row: {
  bootstrap_source_path: string | null;
  bootstrap_content_digest: string | null;
}) {
  return row.bootstrap_source_path && row.bootstrap_content_digest
    ? {
        bootstrap: {
          sourcePath: row.bootstrap_source_path,
          contentDigest: row.bootstrap_content_digest,
        },
      }
    : {};
}
