import type { RawBuilder } from "kysely";

/** @experimental Bounded literal search intent; parsing and budgets stay with the feature owner. */
export type TextQuery =
  | { kind: "term"; text: string }
  | { kind: "phrase"; text: string; prefix?: boolean }
  | { kind: "contains"; text: string }
  | { kind: "all" | "any"; clauses: readonly TextQuery[] };

/** @experimental Existing derived-index declaration, admitted without catalog probes. */
export type TextIndexDefinition = {
  table: string;
  fields: readonly string[];
  alias?: string;
  matchField?: string;
  hiddenRank?: boolean;
  /** PostgreSQL indexes the owner's source/active projection, never immutable history. */
  postgres?: { identity: string; mode?: "trigram" };
};
/** @experimental Index identity bound to one admitted store. */
export type TextIndex = TextIndexDefinition & { readonly store: object };

/** @experimental Native expressions compose with the caller's scoped Kysely statement. */
export interface FullTextCapability {
  match(index: TextIndex, query: TextQuery): RawBuilder<boolean>;
  rank(
    index: TextIndex,
    query?: TextQuery,
    /** PostgreSQL cover-density normalization: none (0) or document length (2, default). */
    options?: { postgres?: { normalization: 0 | 2 } },
  ): {
    value: RawBuilder<number>;
    order: "asc" | "desc";
    toRank(raw: number): number;
  };
  snippet(
    index: TextIndex,
    field: string,
    maxTokens: number,
    query?: TextQuery,
    maxChars?: number,
  ): RawBuilder<string>;
  identity(index: TextIndex): RawBuilder<number>;
  allocatedIdentity(index: TextIndex): RawBuilder<number>;
}
