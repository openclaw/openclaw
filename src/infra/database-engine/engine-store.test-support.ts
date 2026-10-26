import { admitSqliteSchema } from "../sqlite-schema-facts.js";
import type { SearchSchema } from "./contract.js";
import { openEngineStore, readEngineAnchor } from "./open.js";

export function openPostgresEngineTestStore(
  params: Pick<
    Parameters<typeof openEngineStore>[0],
    "anchor" | "schema" | "input" | "existingVersion" | "existingOnly"
  > & { openSqlite?: () => void },
) {
  return openEngineStore({
    ...params,
    openSqlite:
      params.openSqlite ??
      (() => {
        throw new Error("Unexpected SQLite bootstrap");
      }),
    prepareAnchor() {},
    inspectSqlite() {
      admitSqliteSchema(params.anchor);
      return { hasExistingData: false, hasEngineAnchor: Boolean(readEngineAnchor(params.anchor)) };
    },
  });
}

export function createNotesSearch(): SearchSchema {
  return {
    text: {
      notes: { table: "notes", fields: ["text"], postgres: { identity: "id", mode: "trigram" } },
    },
    vector: {
      notes: {
        table: "vectors",
        alias: "v",
        rowShape: { id: "string" },
        postgres: { source: "notes", key: "id", embedding: "embedding", dimensions: 3 },
      },
    },
  };
}
