import type { DatabaseSync } from "node:sqlite";
import { registerNodeSqliteDisposeCallback } from "../infra/kysely-sync-cache-state.js";
import {
  getSqliteReadOperationRevision,
  type SqliteReadOperationRevision,
} from "../infra/sqlite-schema-facts.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import { selectStoredGitHubIdentities } from "./user-profile-github-identity.js";
import { selectUserProfileDisplaysInDatabase } from "./user-profile-identity.read.js";
import { projectUserProfileDisplay } from "./user-profiles-internal.js";
import type { StoredGitHubIdentity, UserProfileDisplay } from "./user-profiles.types.js";

export type UserProfileCatalogIdentityInput =
  | { kind: "source"; profileIds: readonly string[] }
  | { kind: "link"; accountIds: readonly string[]; owners: readonly string[] };

type UserProfileCatalogIdentityFacts = {
  profileId: string;
  profile: UserProfileDisplay | undefined;
  github: StoredGitHubIdentity | undefined;
};

type UserProfileCatalogIdentityResult = { ok: true; facts: UserProfileCatalogIdentityFacts };

export type UserProfileCatalogIdentityRead = {
  profiles: Map<string, UserProfileCatalogIdentityResult>;
  accounts: Map<string, string>;
  owners: Map<string, string>;
};

const retainedPages = new WeakMap<
  DatabaseSync,
  SqliteReadOperationRevision & { pages: Map<string, UserProfileCatalogIdentityRead> }
>();
const MAX_RETAINED_PAGES = 8;
const MAX_RETAINED_PROFILES = 1_000;

function readDisplays(
  db: DatabaseSync,
  ids: readonly string[],
): ReturnType<typeof selectUserProfileDisplaysInDatabase> {
  return tableExists(db, "user_profiles")
    ? selectUserProfileDisplaysInDatabase(db, ids)
    : new Map();
}

function readIdentities(
  db: DatabaseSync,
  ids?: readonly string[],
): ReturnType<typeof selectStoredGitHubIdentities> {
  return tableExists(db, "user_profile_identities")
    ? selectStoredGitHubIdentities(db, ids)
    : new Map();
}

function readProfiles(
  db: DatabaseSync,
  ids: readonly string[],
  includeGitHub: boolean,
): Map<string, UserProfileCatalogIdentityResult> {
  if (!ids.length) {
    return new Map();
  }
  const rows = readDisplays(db, ids);
  const canonicalIds = [...new Set(ids.map((id) => rows.get(id)?.id ?? id))];
  const identities = includeGitHub ? readIdentities(db, canonicalIds) : undefined;
  return new Map(
    ids.map((id): [string, UserProfileCatalogIdentityResult] => {
      const row = rows.get(id);
      const profileId = row?.id ?? id;
      return [
        id,
        {
          ok: true,
          facts: {
            profileId,
            profile: row ? projectUserProfileDisplay(row) : undefined,
            github: identities?.get(profileId)?.primary,
          },
        },
      ];
    }),
  );
}

function readCatalogIdentity(db: DatabaseSync, input: UserProfileCatalogIdentityInput) {
  const accounts = new Map<string, string>();
  const owners = new Map<string, string>();
  if (input.kind === "source") {
    return { profiles: readProfiles(db, [...new Set(input.profileIds)], true), accounts, owners };
  }
  const byAccount = new Map<string, string>();
  const byLogin = new Map<string, string>();
  for (const [profileId, identity] of readIdentities(db)) {
    for (const account of identity.accounts) {
      const id = String(account.accountId);
      const login = account.login.toLowerCase();
      if (!byAccount.has(id)) {
        byAccount.set(id, profileId);
      }
      if (!byLogin.has(login)) {
        byLogin.set(login, profileId);
      }
    }
  }
  for (const id of input.accountIds) {
    const profileId = byAccount.get(id);
    if (profileId) {
      accounts.set(id, profileId);
    }
  }
  for (const owner of input.owners) {
    const profileId = owner.startsWith("profile:")
      ? owner.slice("profile:".length)
      : owner.startsWith("github:")
        ? byLogin.get(owner.slice("github:".length).toLowerCase())
        : undefined;
    if (profileId) {
      owners.set(owner, profileId);
    }
  }
  return {
    profiles: readProfiles(db, [...new Set([...owners.values(), ...accounts.values()])], false),
    accounts,
    owners,
  };
}

/** Committed writer revisions retain pages only while the read remains unchanged and unpinned. */
export function readUserProfileCatalogIdentity(
  db: DatabaseSync,
  input: UserProfileCatalogIdentityInput,
): UserProfileCatalogIdentityRead {
  const revision = getSqliteReadOperationRevision(db);
  const key = JSON.stringify(input);
  let retained = retainedPages.get(db);
  if (revision) {
    if (!retained) {
      retained = { ...revision, pages: new Map() };
      retainedPages.set(db, retained);
      registerNodeSqliteDisposeCallback(db, () => retainedPages.delete(db));
    } else if (
      retained.schema !== revision.schema ||
      retained.writeRevision !== revision.writeRevision ||
      retained.mutationRevision !== revision.mutationRevision
    ) {
      Object.assign(retained, revision);
      retained.pages.clear();
    }
    const previous = retained.pages.get(key);
    if (previous) {
      return previous;
    }
  }
  const result = readCatalogIdentity(db, input);
  if (
    revision &&
    getSqliteReadOperationRevision(db) === revision &&
    retained &&
    result.profiles.size <= MAX_RETAINED_PROFILES
  ) {
    if (retained.pages.size >= MAX_RETAINED_PAGES) {
      retained.pages.delete(retained.pages.keys().next().value!);
    }
    retained.pages.set(key, result);
  }
  return result;
}
