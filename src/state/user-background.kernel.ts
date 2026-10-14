import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  normalizeBackgroundPreference,
  selectBackgroundSource,
  USER_BACKGROUND_PREFERENCE_KEY,
} from "../../packages/gateway-protocol/src/schema/background-preferences.js";
import type {
  UsersBackgroundRemoveParams,
  UsersBackgroundResult,
} from "../../packages/gateway-protocol/src/schema/users-background.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  deleteUserBackgroundImage,
  readUserBackgroundImage,
  readUserBackgroundAsset,
  writeUserBackgroundImage,
} from "./user-background.store.js";
import type {
  UserBackgroundReadCommand,
  UserBackgroundReadReply,
  UserBackgroundWriteInput,
} from "./user-background.types.js";
import { readUserPreferences, writeUserPreferences } from "./user-preferences.store.js";
import { prepareUserPreferenceUpdate } from "./user-preferences.validation.js";
import { selectResolvedUserProfileMetadataById } from "./user-profiles-internal.js";
type Snapshot = Extract<UsersBackgroundResult, { status: "ok" }>;
const key = USER_BACKGROUND_PREFERENCE_KEY;

function readSnapshot(db: DatabaseSync, profileId: string): Snapshot {
  const row = readUserBackgroundAsset(db, profileId);
  const value = tableExists(db, "user_preferences")
    ? readUserPreferences(db, profileId, [key])[key]
    : undefined;
  return {
    status: "ok",
    asset: row
      ? {
          assetId: row.asset_id,
          width: row.width,
          height: row.height,
          mime: "image/jpeg",
          byteLength: row.byte_length,
        }
      : null,
    preference: normalizeBackgroundPreference(value) ?? null,
  };
}

function resolveProfile(db: DatabaseSync, profileId: string): string | undefined {
  return tableExists(db, "user_profiles")
    ? selectResolvedUserProfileMetadataById(db, profileId)?.id
    : undefined;
}

export function readUserBackgroundCommand(
  db: DatabaseSync,
  command: UserBackgroundReadCommand,
): UserBackgroundReadReply {
  return runSqliteDeferredTransactionSync(db, () => {
    const owner = resolveProfile(db, command.profileId);
    if (command.type === "userBackground.snapshot") {
      return {
        type: command.type,
        profileId: owner,
        result: owner ? readSnapshot(db, owner) : { status: "no_durable_identity" },
      };
    }
    if (!command.includeBytes) {
      const asset = owner ? readUserBackgroundAsset(db, owner) : undefined;
      return {
        type: command.type,
        image: undefined,
        byteLength: asset?.asset_id === command.assetId ? asset.byte_length : undefined,
      };
    }
    const row = owner ? readUserBackgroundImage(db, owner, command.assetId) : undefined;
    return { type: command.type, image: row?.image, byteLength: row?.image.byteLength };
  });
}

function matchesExpected(current: Snapshot, expected: UsersBackgroundRemoveParams): boolean {
  return (
    (current.asset?.assetId ?? null) === expected.expectedAssetId &&
    isDeepStrictEqual(current.preference, expected.expectedPreference)
  );
}

export function commitUserBackgroundInDatabase(
  db: DatabaseSync,
  input: UserBackgroundWriteInput,
): UsersBackgroundResult {
  const { profileId, expected, image } = input;
  // An in-flight upload must never be redirected into a newly linked profile.
  if (resolveProfile(db, profileId) !== profileId) {
    return { status: "conflict" };
  }
  const current = readSnapshot(db, profileId);
  if (!matchesExpected(current, expected)) {
    return { status: "conflict" };
  }
  const assetId = image ? randomUUID() : undefined;
  const preference = assetId
    ? {
        ...selectBackgroundSource(
          { kind: "custom", assetId },
          current.asset ? (current.preference ?? undefined) : undefined,
        ),
        // A first upload keeps its conservative placement defaults, but must
        // not discard the presentation the person just selected in Appearance.
        ...(current.preference?.presentation
          ? { presentation: current.preference.presentation }
          : {}),
      }
    : current.preference?.source.kind === "custom"
      ? { ...current.preference, source: { kind: "none" as const } }
      : current.preference;
  if (image && assetId) {
    writeUserBackgroundImage(db, { profile_id: profileId, asset_id: assetId, ...image });
  } else {
    deleteUserBackgroundImage(db, profileId);
  }
  const prepared = prepareUserPreferenceUpdate(
    { [key]: preference },
    { [key]: current.preference },
  );
  if (!prepared.ok) {
    throw new Error("Invalid background preference");
  }
  const result = writeUserPreferences(db, profileId, prepared.value);
  if (!result.ok) {
    // Roll back the asset too, including a quota failure after first upload.
    throw new Error(`Failed to save background preference: ${result.error.code}`);
  }
  return readSnapshot(db, profileId);
}
