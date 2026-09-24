import type { DatabaseSync } from "node:sqlite";
import { toUSVString } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { executeSqliteQuerySync, sqliteStringSet } from "../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../infra/sqlite-transaction.js";
import { tableExists, tableHasColumn } from "../state/openclaw-state-db-schema-helpers.js";
import { selectStoredGitHubIdentities } from "../state/user-profile-github-identity.js";
import {
  normalizeUserProfileAvatarMime,
  selectProfileDisplayEntries,
  userProfilesDb,
} from "../state/user-profiles-internal.js";
import { buildControlUiUserAvatarPath } from "./control-ui-contract.js";
import {
  MAX_MENTION_POLICY_DIRECTORY_PROFILES,
  MAX_MENTION_POLICY_PROFILES_PER_READ,
  type HumanMentionPolicyReadInput,
  type HumanMentionPolicyReadResult,
  type HumanMentionProfileFacts,
} from "./human-mention-policy-read.types.js";

/** Read one consistent profile-policy snapshot without initializing schema. */
export function readHumanMentionPolicyInDatabase(
  db: DatabaseSync,
  input: HumanMentionPolicyReadInput,
): HumanMentionPolicyReadResult {
  return runSqliteDeferredTransactionSync(db, () => readFacts(db, input));
}

function readFacts(
  db: DatabaseSync,
  input: HumanMentionPolicyReadInput,
): HumanMentionPolicyReadResult {
  const requested = [...new Set(input.profileIds)];
  if (requested.length > MAX_MENTION_POLICY_PROFILES_PER_READ) {
    throw new Error("Mention policy profile read exceeds its preparation budget");
  }
  const unresolved = (requestedId: string): HumanMentionProfileFacts => ({
    requestedId,
    display: { kind: "unresolved" },
    role: null,
    aliases: [],
  });
  if (!tableExists(db, "user_profiles")) {
    return {
      profiles: requested.map(unresolved),
      ...(input.directory ? { directory: { profiles: [], truncated: false } } : {}),
    };
  }
  const directoryRows = input.directory
    ? executeSqliteQuerySync(
        db,
        userProfilesDb(db)
          .selectFrom("user_profiles")
          .select("id")
          .where("merged_into", "is", null)
          .orderBy("created_at", "asc")
          .orderBy("id", "asc")
          .limit(MAX_MENTION_POLICY_DIRECTORY_PROFILES + 1),
      ).rows
    : undefined;
  const directoryIds = directoryRows
    ?.slice(0, MAX_MENTION_POLICY_DIRECTORY_PROFILES)
    .map(({ id }) => id);
  const ids = [...new Set([...requested, ...(directoryIds ?? [])])];
  // Chunk native bindings while retaining the owner codec and one-hop merge semantics.
  const rows = new Map<string, ReturnType<typeof selectProfileDisplayEntries>[number][1]>();
  const load = (cohort: string[]) => {
    for (let offset = 0; offset < cohort.length; offset += 400) {
      for (const [id, row] of selectProfileDisplayEntries(db, cohort.slice(offset, offset + 400))) {
        rows.set(id, row);
      }
    }
  };
  load(ids);
  load(
    [
      ...new Set([...rows.values()].flatMap((row) => (row.merged_into ? [row.merged_into] : []))),
    ].filter((id) => !rows.has(id)),
  );
  const resolve = (id: string) => {
    const row = rows.get(toUSVString(id));
    return row?.merged_into ? (rows.get(row.merged_into) ?? row) : row;
  };
  const canonicalIds = [
    ...new Set(
      ids.flatMap((id) => {
        const row = resolve(id);
        return row ? [row.id] : [];
      }),
    ),
  ];
  const aliases = new Map(canonicalIds.map((id) => [id, [id]]));
  if (canonicalIds.length) {
    for (const row of executeSqliteQuerySync(
      db,
      userProfilesDb(db)
        .selectFrom("user_profiles")
        .select(["id", "merged_into"])
        .where("merged_into", "in", sqliteStringSet(canonicalIds)),
    ).rows) {
      if (row.merged_into) {
        aliases.get(row.merged_into)?.push(row.id);
      }
    }
  }
  const profiles = ids.map((requestedId): HumanMentionProfileFacts => {
    const row = resolve(requestedId);
    if (!row) {
      return unresolved(requestedId);
    }
    const mime = normalizeUserProfileAvatarMime(row.avatar_mime);
    const revision =
      row.avatar_sha256 && mime
        ? row.avatar_sha256 + "-" + mime.slice("image/".length)
        : String(row.updated_at);
    const label = normalizeOptionalString(row.display_name);
    return {
      requestedId,
      display: {
        kind: "resolved",
        profileId: row.id,
        ...(label ? { label } : {}),
        avatarUrl: buildControlUiUserAvatarPath(row.id, revision),
        hasUploadedAvatar: row.has_avatar === 1,
      },
      role: row.role ?? null,
      aliases: aliases.get(row.id) ?? [row.id],
    };
  });
  let directory: HumanMentionPolicyReadResult["directory"];
  if (directoryIds) {
    const logins = new Map<string, string[]>();
    if (
      tableExists(db, "user_profile_identities") &&
      tableHasColumn(db, "user_profile_identities", "canonical_login")
    ) {
      for (let offset = 0; offset < directoryIds.length; offset += 400) {
        for (const [id, identities] of selectStoredGitHubIdentities(
          db,
          directoryIds.slice(offset, offset + 400),
        )) {
          logins.set(
            id,
            identities.accounts.map((account) => account.login),
          );
        }
      }
    }
    directory = {
      profiles: directoryIds.map((id) => ({ id, logins: logins.get(id) ?? [] })),
      truncated: (directoryRows?.length ?? 0) > MAX_MENTION_POLICY_DIRECTORY_PROFILES,
    };
  }
  return { profiles, ...(directory ? { directory } : {}) };
}
