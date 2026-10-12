import fs from "node:fs";
import { hasErrnoCode } from "../../infra/errno.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import {
  withOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly.js";
import { readClaim } from "./legacy-main-session-migration-claims.js";
import type {
  PhysicalStore,
  SessionClaim,
  SessionComparisonClaim,
} from "./legacy-main-session-migration.contract.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  captureSessionRetirementReader,
  withSessionRetirementReaders,
} from "./session-retirement-read.js";

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

/** Doctor retains synchronous full custody claims for its cross-store transactions. */
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

/** Retain every selected store across discovery and comparison; neither phase may adopt a replacement. */
export function prepareComparisonClaimsFromStores(params: {
  legacyAgentId: string;
  ownerAgentId: string;
  stores: PhysicalStore[];
  env: NodeJS.ProcessEnv;
  onUnreadable: (store: PhysicalStore, error: unknown) => void;
}) {
  const readers = params.stores.map((input) => {
    const store = { ...input };
    try {
      inspectSessionStorePath(store.path);
      return { store, reader: captureSessionRetirementReader(store, params.env) };
    } catch (error) {
      return { store, error };
    }
  });
  const failed = new Set<PhysicalStore>();
  const assertCurrent = () => {
    for (const captured of readers) {
      if (failed.has(captured.store)) {
        continue;
      }
      if (!captured.reader) {
        throw captured.error;
      }
      captured.reader.assertCurrent();
    }
  };
  const read = async (): Promise<{
    canonical: SessionComparisonClaim[];
    legacy: SessionComparisonClaim[];
  }> => {
    const targets = new Set<string>();
    const candidates = [];
    failed.clear();
    const unreadable = (store: PhysicalStore, error: unknown) => {
      failed.add(store);
      params.onUnreadable(store, error);
    };
    for (const { store, reader, error: preparationError } of readers) {
      if (!reader) {
        unreadable(store, preparationError);
        continue;
      }
      try {
        const result = await reader.read({ operation: "keys" });
        if (result.operation !== "keys") {
          throw new Error("Legacy key scan returned another retirement operation");
        }
        const keys = result.keys.map((key) => {
          const canonicalKey = canonicalKeyFor(key, params.legacyAgentId, params.ownerAgentId);
          if (canonicalKey) {
            targets.add(canonicalKey);
          }
          return { key, canonicalKey: canonicalKey ?? key };
        });
        candidates.push({ store, reader, keys });
      } catch (error) {
        unreadable(store, error);
      }
    }
    const claims: Array<{ store: PhysicalStore; claim: SessionComparisonClaim }> = [];
    for (const { store, reader, keys } of candidates) {
      const targeted = keys.filter(({ canonicalKey }) => targets.has(canonicalKey));
      if (targeted.length === 0) {
        continue;
      }
      try {
        const result = await reader.read({ operation: "comparison-claims", store, keys: targeted });
        if (result.operation !== "comparison-claims") {
          throw new Error("Legacy claim scan returned another retirement operation");
        }
        claims.push(...result.claims.map((claim) => ({ store, claim })));
      } catch (error) {
        unreadable(store, error);
      }
    }
    for (const { store, reader } of readers) {
      if (!reader || failed.has(store)) {
        continue;
      }
      try {
        reader.assertCurrent();
      } catch (error) {
        unreadable(store, error);
      }
    }
    const canonical: SessionComparisonClaim[] = [];
    const legacy: SessionComparisonClaim[] = [];
    for (const { store, claim } of claims) {
      if (!failed.has(store)) {
        (claim.key === claim.canonicalKey ? canonical : legacy).push(claim);
      }
    }
    return { canonical, legacy };
  };
  return {
    assertCurrent,
    read: () =>
      withSessionRetirementReaders(
        readers.flatMap(({ reader }) => (reader ? [reader] : [])),
        read,
      ),
  };
}

export async function storesHaveLegacyAgentSessionKey(params: {
  legacyAgentId: string;
  stores: PhysicalStore[];
  env: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const readers = params.stores.map((store) => {
    inspectSessionStorePath(store.path);
    return captureSessionRetirementReader(store, params.env);
  });
  return withSessionRetirementReaders(readers, async () => {
    for (const reader of readers) {
      const result = await reader.read({ operation: "keys" });
      if (result.operation !== "keys") {
        throw new Error("Legacy key scan returned another retirement operation");
      }
      if (result.keys.some((key) => legacyAgentKeyPrefix(key, params.legacyAgentId) !== null)) {
        return true;
      }
    }
    for (const reader of readers) {
      reader.assertCurrent();
    }
    return false;
  });
}
