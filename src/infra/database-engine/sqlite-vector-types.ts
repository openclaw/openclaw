import type { SQLInputValue } from "node:sqlite";
import type { VectorRowShape, VectorSearch } from "./vector-contract.js";

export type SqliteVectorStatement = { sql: string; parameters: SQLInputValue[] };

export type SqliteVectorPlan = {
  query: SqliteVectorStatement;
  scopeCount: SqliteVectorStatement;
  vectorTable: string;
  limit: number;
  candidateParameter: number;
  rowShape: VectorRowShape;
  textPrefix?: VectorSearch<unknown>["textPrefix"];
};

export type VectorKnnResponse<Row = unknown> = { rows: Row[]; fallbackScanRequired: boolean };

export type VectorKnnChildInput = {
  databasePath: string;
  extensionPath?: string;
  sqliteLibraryPath?: string;
  request: string;
};
