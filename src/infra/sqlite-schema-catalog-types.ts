export type SqliteColumnCatalog = {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
  readonly hidden: number;
};

export type SqliteForeignKeyCatalog = {
  readonly id: number;
  readonly seq: number;
  readonly table: string;
  readonly from: string;
  readonly to: string | null;
  readonly on_update: string;
  readonly on_delete: string;
  readonly match: string;
};

export type SqliteIndexListRow = {
  name: string;
  origin: string;
  partial: number;
  unique: number;
};

export type SqliteIndexTermRow = {
  cid: number;
  coll: string;
  desc: number;
  key: number;
  name: string | null;
  seqno: number;
};

export type SqliteSchemaRow = {
  name: string;
  sql: string | null;
  tbl_name?: string;
};

export type SqliteTableListRow = {
  schema: string;
  name: string;
  strict: number;
  wr: number;
};

export type SqliteViewCatalog = {
  readonly name: string;
  readonly sql: string | null;
  readonly columns: readonly SqliteColumnCatalog[];
  readonly triggers: readonly Readonly<SqliteSchemaRow>[];
};

export type SqliteSchemaCatalog = {
  readonly tables: readonly {
    readonly name: string;
    readonly sql: string | null;
    readonly strict: number;
    readonly withoutRowid: number;
    readonly columns: readonly SqliteColumnCatalog[];
    readonly foreignKeys: readonly SqliteForeignKeyCatalog[];
    readonly indexes: readonly (Readonly<SqliteIndexListRow> & {
      readonly sql: string | null;
      readonly terms: readonly Readonly<SqliteIndexTermRow>[];
    })[];
    readonly triggers: readonly Readonly<SqliteSchemaRow>[];
  }[];
  readonly views: readonly SqliteViewCatalog[];
};

/** Generated strings have no runtime DDL path; dynamic migration owners supply native facts. */
export type SqliteSchemaSource = string | SqliteSchemaCatalog;
