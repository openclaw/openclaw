import fs from "node:fs";
import path from "node:path";
import { resolvePathPrefixSync } from "@openclaw/fs-safe/advanced";
import { hasErrnoCode } from "../../infra/errno.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import {
  listAgentDatabaseAdmissionRefusals,
  readAgentDatabaseAdmissionRefusal,
} from "../../state/agent-database-admission.js";
import {
  withOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly.js";
import { readClaim } from "./legacy-main-session-migration-claims.js";
import type {
  LegacyMainSessionMigrationResult,
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

export function resolveMissingPhysicalPath(pathname: string): string {
  const prefix = resolvePathPrefixSync(path.resolve(pathname));
  return path.join(prefix.existingPath, ...prefix.unresolvedSegments);
}

export function resolvePhysicalPathIdentity(pathname: string): string {
  try {
    const stat = fs.statSync(pathname, { bigint: true });
    if (!stat.isFile()) {
      throw new Error(`session store is not a regular file: ${pathname}`);
    }
    return `file:${stat.dev}:${stat.ino}`;
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return `missing:${resolveMissingPhysicalPath(pathname)}`;
  }
}

export function resolveSourceLayout(resolved: {
  stores: PhysicalStore[];
  jsonPaths: string[];
}): string[] {
  return [
    ...new Set([
      ...resolved.stores.map(
        (store) => `sqlite:${store.databaseAgentId}:${resolvePhysicalPathIdentity(store.path)}`,
      ),
      ...resolved.jsonPaths.map((pathname) => `json:${resolvePhysicalPathIdentity(pathname)}`),
    ]),
  ].toSorted();
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
        for (const claim of result.claims) {
          claims.push({ store, claim });
        }
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

/** Advisory fleet detection must not reserve healthy writes behind a pending inspection. */
export function readDeferredLegacyMainSessionInspection(params: {
  env: NodeJS.ProcessEnv;
  legacyAgentId: string;
  mainKey: string;
  ownerAgentId?: string;
}): LegacyMainSessionMigrationResult | undefined {
  const pending = listAgentDatabaseAdmissionRefusals({ env: params.env }).filter(
    (refusal) =>
      refusal.code === "agent-database-inspection-pending" &&
      readAgentDatabaseAdmissionRefusal(refusal.agentId, { env: params.env }),
  );
  if (pending.length === 0) {
    return undefined;
  }
  // A later detection/Doctor pass must inspect the full inventory before it can be complete.
  return {
    legacyAgentId: params.legacyAgentId,
    mainKey: params.mainKey,
    ownerAgentId: params.ownerAgentId,
    armed: params.ownerAgentId !== undefined,
    changes: [],
    complete: false,
    ledgerComplete: false,
    outcomes: pending.map((refusal) => ({
      kind: "store-unreadable",
      detail: "Background agent database inspection is pending",
      paths: refusal.paths,
    })),
    warnings: [
      "session: legacy-main detection deferred while background agent database preparation is pending",
    ],
  };
}
