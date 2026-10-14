import type { RawBuilder, RootOperationNode } from "kysely";

/** @experimental Primitive fields expected from an admitted vector query projection. */
export type VectorRowShape = Readonly<
  Record<string, "string" | "number" | "finite-number" | readonly string[]>
>;

/** @experimental Validate native and transported rows against the same admitted projection. */
export function matchesVectorRow(value: unknown, shape: VectorRowShape): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.entries(shape).every(([key, expected]) => {
    const field = Reflect.get(value, key);
    if (typeof expected !== "string") {
      return typeof field === "string" && expected.includes(field);
    }
    return expected === "finite-number"
      ? typeof field === "number" && Number.isFinite(field)
      : typeof field === expected;
  });
}

/** @experimental A vector index bound to its admitted store. */
export type VectorIndex = {
  readonly store: object;
  readonly table: string;
  readonly alias: string;
  readonly rowShape: VectorRowShape;
};

/** @experimental Caller-owned scope and projection around native vector candidates. */
export type VectorSearch<Row> = {
  index: VectorIndex;
  vector: readonly number[];
  limit: number;
  textPrefix?: { column: string; maxChars: number };
  query: (native: { match: RawBuilder<boolean>; distance: RawBuilder<number> }) => {
    toOperationNode(): RootOperationNode;
  };
  scopeCount: { toOperationNode(): RootOperationNode };
  isRow: (value: unknown) => value is Row;
  signal?: AbortSignal;
  extensionPath?: string;
};

/** @experimental Approximate L2 candidates with cosine reranking; feature owners retain exact fallback. */
export interface VectorCapability {
  prepareExists(index: VectorIndex): (id: string) => boolean;
  nearest<Row>(request: VectorSearch<Row>): Promise<{
    rows: Row[];
    fallbackScanRequired: boolean;
  }>;
  remove(
    index: VectorIndex,
    scope: readonly string[] | { toOperationNode(): RootOperationNode },
  ): void;
  drop(index: VectorIndex): void;
  create(index: VectorIndex, dimensions: number, ifNotExists?: boolean): void;
  write(index: VectorIndex, rows: readonly { id: string; embedding: number[] }[]): void;
}
