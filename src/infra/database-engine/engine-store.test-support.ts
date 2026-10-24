import { admitSqliteSchema } from "../sqlite-schema-facts.js";
import { openEngineStore, readEngineAnchor } from "./open.js";

export function openPostgresEngineTestStore(
  params: Pick<
    Parameters<typeof openEngineStore>[0],
    "anchor" | "schema" | "input" | "openSqlite" | "existingVersion" | "existingOnly"
  >,
) {
  return openEngineStore({
    ...params,
    prepareAnchor() {},
    inspectSqlite() {
      admitSqliteSchema(params.anchor);
      return { hasExistingData: false, hasEngineAnchor: Boolean(readEngineAnchor(params.anchor)) };
    },
  });
}
