import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { openEngineStore, readEngineAnchor } from "./open.js";
import type { PortDescriptor } from "./port-descriptor.js";
import { withLegacyPostgresIndexOrdering } from "./postgres-index-ordering.js";

/** Reopen an exact historical schema without allowing current-owner migrations. */
export function historicalPortVersion(
  descriptor: PortDescriptor,
  version: number,
  postgres: string,
): PortDescriptor {
  return {
    ...descriptor,
    version,
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
            postgres,
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

/** Restore the previous generated index policy without upgrading a recovery image. */
export function historicalIndexOrderingPort(
  descriptor: PortDescriptor,
  version: number,
  postgres: string,
  policy: "sqlite" | "schema-nullability" = "sqlite",
): PortDescriptor {
  return historicalPortVersion(
    {
      ...descriptor,
      postData: withLegacyPostgresIndexOrdering(descriptor.postData, policy, descriptor.preData),
    },
    version,
    withLegacyPostgresIndexOrdering(postgres, policy),
  );
}
