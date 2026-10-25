import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { openEngineStore, readEngineAnchor } from "./open.js";
import type { PortDescriptor } from "./port-descriptor.js";
import { withLegacyPostgresIndexOrdering } from "./postgres-index-ordering.js";

/** Restore the previous generated index policy without upgrading a recovery image. */
export function historicalIndexOrderingPort(
  descriptor: PortDescriptor,
  version: number,
  postgres: string,
): PortDescriptor {
  return {
    ...descriptor,
    version,
    postData: withLegacyPostgresIndexOrdering(descriptor.postData),
    inspectSqliteSource: undefined,
    migrateSqliteSource: undefined,
    admit(file, input) {
      if (!input) {
        return;
      }
      withEngineStoreAdmission(() => {
        using anchor = openNodeSqliteDatabase(file);
        const db = openEngineStore({
          anchor,
          input,
          schema: {
            id: descriptor.id,
            version,
            sqlite: descriptor.sqlite,
            postgres: withLegacyPostgresIndexOrdering(postgres),
          },
          existingOnly: true,
          inspectSqlite: () => ({
            hasEngineAnchor: Boolean(readEngineAnchor(anchor)),
            hasExistingData: false,
          }),
          prepareAnchor: () => {},
          openSqlite: () => {},
        });
        if (db !== anchor) {
          db.close();
        }
      });
    },
  };
}
