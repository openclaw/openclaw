import fs from "node:fs";
import { hasErrnoCode } from "../../infra/errno.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import {
  withOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly.js";
import { readClaim } from "./legacy-main-session-migration-claims.js";
import type { PhysicalStore, SessionClaim } from "./legacy-main-session-migration.contract.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";

export function inspectSessionStorePath(pathname: string): "missing" | "present" {
  let entry: fs.Stats;
  try {
    entry = fs.lstatSync(pathname);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return "missing";
    }
    throw error;
  }
  const target = entry.isSymbolicLink() ? fs.statSync(pathname) : entry;
  if (!target.isFile()) {
    throw new Error(`session store is not a regular file: ${pathname}`);
  }
  return "present";
}

/** Returns the stored `agent:<id>:` prefix when the key is owned by the legacy agent. */
function legacyAgentKeyPrefix(key: string, legacyAgentId: string): string | null {
  const parsed = parseAgentSessionKey(key);
  if (!parsed || normalizeAgentId(parsed.agentId) !== legacyAgentId) {
    return null;
  }
  const prefix = `agent:${parsed.agentId}:`;
  return key.startsWith(prefix) ? prefix : null;
}

function canonicalKeyFor(key: string, legacyAgentId: string, ownerAgentId: string): string | null {
  const prefix = legacyAgentKeyPrefix(key, legacyAgentId);
  return prefix ? `agent:${ownerAgentId}:${key.slice(prefix.length)}` : null;
}

export function storeHasLegacyAgentSessionKey(params: {
  legacyAgentId: string;
  store: PhysicalStore;
  env: NodeJS.ProcessEnv;
}): boolean {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db).selectFrom("session_nodes").select("session_key"),
      ).rows.some((row) => legacyAgentKeyPrefix(row.session_key, params.legacyAgentId) !== null),
    { agentId: params.store.databaseAgentId, env: params.env, path: params.store.path },
  );
  // A missing database, schema, or table proves absence exactly as the armed claim
  // reader does below; only genuine read failures throw and let the caller fail open.
  return result.found ? result.value : false;
}

export function readClaimsFromStores(params: {
  legacyAgentId: string;
  ownerAgentId: string;
  stores: PhysicalStore[];
  env: NodeJS.ProcessEnv;
  onUnreadable: (store: PhysicalStore, error: unknown) => void;
}): { canonical: SessionClaim[]; legacy: SessionClaim[] } {
  const targets = new Set<string>();
  const candidates = new Map<PhysicalStore, Array<{ key: string; canonicalKey: string }>>();
  const readStore = <T>(
    store: PhysicalStore,
    read: (database: OpenClawAgentReadOnlyDatabase) => T,
  ) => {
    try {
      if (inspectSessionStorePath(store.path) === "missing") {
        return undefined;
      }
      const result = withOpenClawAgentDatabaseReadOnly(read, {
        agentId: store.databaseAgentId,
        env: params.env,
        path: store.path,
      });
      return result.found ? result.value : undefined;
    } catch (error) {
      params.onUnreadable(store, error);
      return undefined;
    }
  };
  for (const store of params.stores) {
    const keys = readStore(
      store,
      (database) =>
        executeSqliteQuerySync(
          database.db,
          getSessionKysely(database.db).selectFrom("session_nodes").select("session_key"),
        ).rows,
    );
    if (keys) {
      candidates.set(
        store,
        keys.map(({ session_key: key }) => {
          const canonicalKey = canonicalKeyFor(key, params.legacyAgentId, params.ownerAgentId);
          if (canonicalKey) {
            targets.add(canonicalKey);
          }
          return { key, canonicalKey: canonicalKey ?? key };
        }),
      );
    }
  }
  const canonical: SessionClaim[] = [];
  const legacy: SessionClaim[] = [];
  // A legacy alias may target a canonical claim in a different physical store.
  for (const [store, keys] of candidates) {
    const targeted = keys.filter(({ canonicalKey }) => targets.has(canonicalKey));
    if (targeted.length === 0) {
      continue;
    }
    const claims = readStore(store, (database) =>
      targeted.flatMap(({ key, canonicalKey }) => {
        const claim = readClaim(database, store, key, canonicalKey);
        return claim ? [claim] : [];
      }),
    );
    for (const claim of claims ?? []) {
      (claim.key === claim.canonicalKey ? canonical : legacy).push(claim);
    }
  }
  return { canonical, legacy };
}
