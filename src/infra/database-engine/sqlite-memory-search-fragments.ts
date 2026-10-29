// Canonical deployed lazy memory FTS definitions; no runtime provider dependency.
type TextFragment = {
  kind: "body-fts" | "path-fts";
  tableName: string;
  tokenizer: "unicode61" | "trigram";
};
function buildTextSchema(
  fragment: Pick<TextFragment, "kind" | "tableName">,
  tokenizeClause: string,
): string {
  if (fragment.kind === "body-fts") {
    return (
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${fragment.tableName} USING fts5(\n` +
      `  text,\n` +
      `  id UNINDEXED,\n` +
      `  path UNINDEXED,\n` +
      `  source UNINDEXED,\n` +
      `  model UNINDEXED,\n` +
      `  start_line UNINDEXED,\n` +
      `  end_line UNINDEXED\n` +
      `${tokenizeClause});`
    );
  }
  return `
      CREATE VIRTUAL TABLE IF NOT EXISTS ${fragment.tableName} USING fts5(
        path,
        source UNINDEXED
        ${tokenizeClause}
      );
    `;
}

function tokenizerClause(tokenizer: TextFragment["tokenizer"]): string {
  return tokenizer === "trigram" ? `, tokenize='trigram case_sensitive 0'` : "";
}

/** Canonical DDL shared by lazy creation and deployed-schema recovery. */
export function buildSqliteMemoryBodyFtsSchema(params: {
  tableName: string;
  tokenizeClause: string;
}): string {
  return buildTextSchema({ kind: "body-fts", tableName: params.tableName }, params.tokenizeClause);
}

export function buildSqliteMemoryPathFtsSchema(params: { tokenizeClause: string }): string {
  return buildTextSchema(
    { kind: "path-fts", tableName: "memory_index_paths_fts" },
    params.tokenizeClause,
  );
}

export function getSqliteMemorySearchFtsSchemas(): string[] {
  return (["body-fts", "path-fts"] as const).flatMap((kind) => {
    const fragment: TextFragment = {
      kind,
      tableName: kind === "body-fts" ? "memory_index_chunks_fts" : "memory_index_paths_fts",
      tokenizer: "unicode61",
    };
    return [
      buildTextSchema(fragment, ""),
      buildTextSchema(fragment, ", tokenize='unicode61'"),
      buildTextSchema(fragment, ', tokenize="unicode61"'),
      buildTextSchema(fragment, tokenizerClause("trigram")),
    ];
  });
}
