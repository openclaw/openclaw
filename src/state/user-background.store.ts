import type { DatabaseSync } from "node:sqlite";
import { normalizeBackgroundPreference } from "../../packages/gateway-protocol/src/schema/background-preferences.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import { createOpenClawStateSchemaEnsurer } from "./openclaw-state-feature-schema.js";

type BackgroundDatabase = Pick<DB, "user_background_images">;
export const ensureUserBackgroundSchema = createOpenClawStateSchemaEnsurer({
  table: "user_background_images",
  operationLabel: "users.background.schema.ensure",
});

export function readUserBackgroundImage(db: DatabaseSync, profileId: string, assetId: string) {
  if (!tableExists(db, "user_background_images")) {
    return undefined;
  }
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<BackgroundDatabase>(db)
      .selectFrom("user_background_images")
      .selectAll()
      .where("profile_id", "=", profileId)
      .where("asset_id", "=", assetId),
  );
}

/** Preference edits and settings previews never materialize the retained image payload. */
export function readUserBackgroundAsset(db: DatabaseSync, profileId: string) {
  if (!tableExists(db, "user_background_images")) {
    return undefined;
  }
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<BackgroundDatabase>(db)
      .selectFrom("user_background_images")
      .select(["asset_id", "width", "height"])
      .select((eb) => eb.fn<number>("length", ["image"]).as("byte_length"))
      .where("profile_id", "=", profileId),
  );
}

/** The same validation runs for ordinary preference writes and atomic upload selection. */
export function isOwnedBackgroundPreference(
  db: DatabaseSync,
  profileId: string,
  value: unknown,
): boolean {
  const preference = normalizeBackgroundPreference(value);
  return Boolean(
    preference &&
    (preference.source.kind !== "custom" ||
      readUserBackgroundAsset(db, profileId)?.asset_id === preference.source.assetId),
  );
}

export function writeUserBackgroundImage(
  db: DatabaseSync,
  row: DB["user_background_images"],
): void {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<BackgroundDatabase>(db)
      .insertInto("user_background_images")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("profile_id").doUpdateSet({
          asset_id: row.asset_id,
          image: row.image,
          width: row.width,
          height: row.height,
        }),
      ),
  );
}

export function deleteUserBackgroundImage(db: DatabaseSync, profileId: string): void {
  if (tableExists(db, "user_background_images")) {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<BackgroundDatabase>(db)
        .deleteFrom("user_background_images")
        .where("profile_id", "=", profileId),
    );
  }
}

/** Profile linking preserves the target upload, or transfers the source without duplicating it. */
export function mergeUserBackgroundImages(
  db: DatabaseSync,
  sourceId: string,
  targetId: string,
): void {
  if (sourceId === targetId || !tableExists(db, "user_background_images")) {
    return;
  }
  if (readUserBackgroundAsset(db, targetId)) {
    deleteUserBackgroundImage(db, sourceId);
    return;
  }
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<BackgroundDatabase>(db)
      .updateTable("user_background_images")
      .set({ profile_id: targetId })
      .where("profile_id", "=", sourceId),
  );
}
