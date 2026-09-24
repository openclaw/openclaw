import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { hasErrnoCode } from "../../infra/errno.js";
import { LEGACY_IMPLICIT_AGENT_ID, normalizeAgentId } from "../../routing/session-key.js";
import type { OpenClawRegisteredAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { prepareOpenClawAgentDatabaseRegistrySnapshotRead } from "../../state/openclaw-agent-db-registry-listing.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  listOpenClawRegisteredAgentDatabases,
} from "../../state/openclaw-agent-db-registry.js";
import {
  inspectOpenClawAgentDatabaseOwner,
  isIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import {
  assertSessionStoreReadCandidate,
  type SessionStoreReadCandidate,
} from "./session-store-read-candidates.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

/** SQLite database target resolved from a legacy session store path. */
export type ResolvedSqliteStoreTarget = {
  agentId?: string;
  ownerSource?:
    | "database-registry"
    | "database-path"
    | "registered-suffixed"
    | "occupied-unsuffixed"
    | "configured-default"
    | "ambiguous-registry";
  path: string;
  shared?: boolean;
  unsuffixedOwnerAgentId?: string;
};

type ResolveSqliteStoreTargetOptions = {
  agentId?: string;
  defaultAgentId?: string;
  env?: NodeJS.ProcessEnv;
  registeredDatabases?: SessionStoreRegistryRead;
  isSameDatabasePath?: (left: string, right: string) => boolean;
  readCandidates?: readonly SessionStoreReadCandidate[];
  /** Reports ordinary locator data failures, never candidate custody or native cleanup. */
  onReadError?: (error: unknown) => never;
};

export type SessionStoreRegistryRead =
  | readonly Pick<OpenClawRegisteredAgentDatabase, "agentId" | "path">[]
  | { status: "deferred" | "unavailable" };

export class SessionStoreRegistryReadRequired extends Error {}

/** Demand registry facts only where target ownership actually consults them. */
export function readSessionStoreRegistryRows(
  registry: SessionStoreRegistryRead | undefined,
  env?: NodeJS.ProcessEnv,
  onReadError?: (error: unknown) => never,
): readonly Pick<OpenClawRegisteredAgentDatabase, "agentId" | "path">[] {
  if (registry && "status" in registry) {
    if (registry.status === "deferred") {
      throw new SessionStoreRegistryReadRequired("Session target discovery requires registry rows");
    }
    const error = new Error("Session target registry is unavailable");
    onReadError?.(error);
    throw error;
  }
  return registry ?? listOpenClawRegisteredAgentDatabases({ env });
}

/** Resolve physical ownership before the transcript reader acquires database custody. */
export async function prepareSqliteTargetFromSessionStorePath(
  storePath: string,
  options: Pick<ResolveSqliteStoreTargetOptions, "agentId" | "defaultAgentId" | "env"> = {},
  signal?: AbortSignal,
): Promise<ResolvedSqliteStoreTarget> {
  signal?.throwIfAborted();
  const pathname = path.resolve(storePath);
  const unsuffixed = resolveUnsuffixedSqliteTargetFromSessionStorePath(pathname);
  if (unsuffixed.agentId) {
    return unsuffixed;
  }
  const env = captureSessionTranscriptStorageEnvironment(options.env ?? process.env);
  const registryRead = prepareOpenClawAgentDatabaseRegistrySnapshotRead({ env });
  const input = {
    storePath: pathname,
    agentId: options.agentId,
    defaultAgentId: options.defaultAgentId,
    env,
  };
  signal?.throwIfAborted();
  const registry = await registryRead.read();
  try {
    registry.assertCurrent();
    signal?.throwIfAborted();
    const registeredDatabases = readSessionStoreRegistryRows(
      registry.result.status === "available" ? registry.result.entries : registry.result,
    );
    const { resolveSessionSqliteTargetInWorker } =
      await import("./session-transcript-read-worker-runtime.js");
    registry.assertCurrent();
    signal?.throwIfAborted();
    return await resolveSessionSqliteTargetInWorker({ ...input, registeredDatabases }, signal);
  } finally {
    registry.assertCurrent();
    signal?.throwIfAborted();
  }
}

function resolveRegisteredOwners(
  pathname: string,
  registeredDatabases: readonly Pick<OpenClawRegisteredAgentDatabase, "agentId" | "path">[],
  isSameDatabasePath: (left: string, right: string) => boolean,
): string[] {
  return [
    ...new Set(
      registeredDatabases
        .filter((entry) => isSameDatabasePath(entry.path, pathname))
        .map((entry) => normalizeAgentId(entry.agentId)),
    ),
  ];
}

function resolveDatabaseOwner(
  pathname: string,
  readCandidates?: readonly SessionStoreReadCandidate[],
  onReadError?: (error: unknown) => never,
): string | undefined {
  if (!hasFilesystemEntry(pathname, onReadError)) {
    return undefined;
  }
  const physicalPath = readCandidates
    ? assertSessionStoreReadCandidate(pathname, readCandidates)
    : pathname;
  const owner = inspectOpenClawAgentDatabaseOwner(physicalPath);
  return owner.status === "owned" ? normalizeAgentId(owner.agentId) : undefined;
}

function hasFilesystemEntry(pathname: string, onReadError?: (error: unknown) => never): boolean {
  try {
    lstatSync(pathname);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    onReadError?.(error);
    throw error;
  }
}

function resolveCustomStoreSqlitePath(params: {
  unsuffixedPath: string;
  options: ResolveSqliteStoreTargetOptions;
}): ResolvedSqliteStoreTarget {
  const unsuffixedPath = path.resolve(params.unsuffixedPath);
  const sqliteBaseName = path.basename(unsuffixedPath, ".sqlite");
  const sessionsDir = path.dirname(unsuffixedPath);
  const defaultAgentId = normalizeAgentId(params.options.defaultAgentId ?? "main");
  const agentId = normalizeAgentId(params.options.agentId ?? defaultAgentId);
  const registeredDatabases = readSessionStoreRegistryRows(
    params.options.registeredDatabases,
    params.options.env,
    params.options.onReadError,
  );
  const isSameDatabasePath =
    params.options.isSameDatabasePath ?? createOpenClawAgentDatabasePathMatcher();
  const resolvePersistedOwner = (candidatePath: string) => {
    const registeredOwners = resolveRegisteredOwners(
      candidatePath,
      registeredDatabases,
      isSameDatabasePath,
    );
    let databaseOwner: string | undefined;
    if (registeredOwners.length === 1) {
      // Registry precedence makes inspection redundant, but filesystem errors still propagate.
      hasFilesystemEntry(candidatePath, params.options.onReadError);
    } else {
      databaseOwner = resolveDatabaseOwner(
        candidatePath,
        params.options.readCandidates,
        params.options.onReadError,
      );
    }
    return {
      effectiveOwner:
        registeredOwners.length === 1
          ? registeredOwners[0]
          : registeredOwners.length === 0
            ? databaseOwner
            : undefined,
      registeredOwners,
    };
  };
  const { registeredOwners: registeredUnsuffixedOwners, effectiveOwner: persistedUnsuffixedOwner } =
    resolvePersistedOwner(unsuffixedPath);
  const suffixedPathFor = (ownerAgentId: string) =>
    path.join(sessionsDir, `${sqliteBaseName}.${ownerAgentId}.sqlite`);
  const resolveSuffixedTarget = (ownerAgentId: string) => {
    const prefix = `${sqliteBaseName}.${ownerAgentId}`;
    const parseIndex = (fileName: string): number | undefined => {
      if (fileName === `${prefix}.sqlite`) {
        return 1;
      }
      if (!fileName.startsWith(`${prefix}.`) || !fileName.endsWith(".sqlite")) {
        return undefined;
      }
      const rawValue = fileName.slice(prefix.length + 1, -".sqlite".length);
      if (!/^[1-9]\d*$/.test(rawValue)) {
        return undefined;
      }
      const value = Number(rawValue);
      return Number.isSafeInteger(value) && value >= 2 && String(value) === rawValue
        ? value
        : undefined;
    };
    const occupiedIndexes = new Set<number>();
    for (const registered of registeredDatabases) {
      if (!isSameDatabasePath(path.dirname(registered.path), sessionsDir)) {
        continue;
      }
      const index = parseIndex(path.basename(registered.path));
      if (index !== undefined) {
        occupiedIndexes.add(index);
      }
    }
    try {
      for (const fileName of readdirSync(sessionsDir)) {
        const index = parseIndex(fileName);
        if (index !== undefined) {
          occupiedIndexes.add(index);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        params.options.onReadError?.(error);
        throw error;
      }
      // A missing target directory has no occupied on-disk suffixes.
    }
    const candidatePathAt = (index: number) =>
      index === 1
        ? suffixedPathFor(ownerAgentId)
        : path.join(sessionsDir, `${prefix}.${index}.sqlite`);
    const sortedOccupiedIndexes = [...occupiedIndexes].toSorted((left, right) => left - right);
    for (const index of sortedOccupiedIndexes) {
      const candidatePath = candidatePathAt(index);
      if (resolvePersistedOwner(candidatePath).effectiveOwner === ownerAgentId) {
        return { owned: true, path: candidatePath };
      }
    }
    let firstMissingIndex = 1;
    for (const index of sortedOccupiedIndexes) {
      if (index === firstMissingIndex) {
        firstMissingIndex += 1;
      } else if (index > firstMissingIndex) {
        break;
      }
    }
    for (let index = firstMissingIndex; ; index += 1) {
      const candidatePath = candidatePathAt(index);
      const candidateOwner = resolvePersistedOwner(candidatePath);
      if (candidateOwner.effectiveOwner === ownerAgentId) {
        return { owned: true, path: candidatePath };
      }
      if (
        candidateOwner.registeredOwners.length === 0 &&
        !hasFilesystemEntry(candidatePath, params.options.onReadError)
      ) {
        return { owned: false, path: candidatePath };
      }
    }
  };
  const defaultSuffixedTarget = resolveSuffixedTarget(defaultAgentId);
  const agentSuffixedTarget =
    agentId === defaultAgentId ? defaultSuffixedTarget : resolveSuffixedTarget(agentId);
  const defaultOwnsSuffixedPath = defaultSuffixedTarget.owned;
  const agentOwnsSuffixedPath = agentSuffixedTarget.owned;
  const unsuffixedAvailable =
    registeredUnsuffixedOwners.length === 0 &&
    !hasFilesystemEntry(unsuffixedPath, params.options.onReadError);
  const fallbackUnsuffixedOwner =
    persistedUnsuffixedOwner || defaultOwnsSuffixedPath || !unsuffixedAvailable
      ? undefined
      : defaultAgentId;
  const unsuffixedOwnerAgentId = persistedUnsuffixedOwner ?? fallbackUnsuffixedOwner;
  const useUnsuffixedPath =
    agentId === persistedUnsuffixedOwner ||
    (!agentOwnsSuffixedPath && agentId === fallbackUnsuffixedOwner);
  const ownerSource = persistedUnsuffixedOwner
    ? registeredUnsuffixedOwners.length === 1
      ? "database-registry"
      : "database-path"
    : defaultOwnsSuffixedPath
      ? "registered-suffixed"
      : registeredUnsuffixedOwners.length > 1
        ? "ambiguous-registry"
        : !unsuffixedAvailable
          ? "occupied-unsuffixed"
          : "configured-default";
  // Fixed-store precedence is: persisted unsuffixed owner, the agent's own persisted suffix,
  // configured-default unsuffixed ownership, then a new suffix. Filenames never infer ownership.
  // This keeps promotions stable and guarantees one physical SQLite target per agent.
  return {
    agentId,
    path: useUnsuffixedPath ? unsuffixedPath : agentSuffixedTarget.path,
    ownerSource,
    ...(unsuffixedOwnerAgentId ? { unsuffixedOwnerAgentId } : {}),
  };
}

/** Resolves only the legacy unsuffixed target, without reading ownership state. */
export function resolveUnsuffixedSqliteTargetFromSessionStorePath(
  storePath: string,
): ResolvedSqliteStoreTarget {
  const resolved = path.resolve(storePath);
  if (path.basename(resolved) === "openclaw-agent.sqlite" || resolved.endsWith(".sqlite")) {
    const agentId = resolveAgentIdFromSqliteDatabasePath(resolved);
    return { path: resolved, ...(agentId ? { agentId } : { shared: true }) };
  }
  const sessionsDir = path.dirname(resolved);
  if (path.basename(resolved) !== "sessions.json") {
    const sqliteBaseName = path.basename(resolved, path.extname(resolved)) || "openclaw-agent";
    return { path: path.join(sessionsDir, `${sqliteBaseName}.sqlite`) };
  }
  if (path.basename(sessionsDir) !== "sessions") {
    return { path: path.join(sessionsDir, "openclaw-agent.sqlite") };
  }
  const agentDir = path.dirname(sessionsDir);
  if (path.basename(path.dirname(agentDir)) !== "agents") {
    return { path: path.join(sessionsDir, "openclaw-agent.sqlite") };
  }
  return {
    agentId: normalizeAgentId(path.basename(agentDir)),
    path: path.join(agentDir, "agent", "openclaw-agent.sqlite"),
  };
}

/** Resolves the SQLite database target that owns a legacy session store path. */
export function resolveSqliteTargetFromSessionStorePath(
  storePath: string,
  options: ResolveSqliteStoreTargetOptions = {},
): ResolvedSqliteStoreTarget {
  const unsuffixedTarget = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
  const requestedAgentId = options.agentId ? normalizeAgentId(options.agentId) : undefined;
  if (
    requestedAgentId &&
    isIncognitoOpenClawAgentSqlitePath(unsuffixedTarget.path, {
      agentId: requestedAgentId,
      env: options.env,
    })
  ) {
    return { agentId: requestedAgentId, path: unsuffixedTarget.path };
  }
  if (unsuffixedTarget.agentId) {
    return unsuffixedTarget;
  }
  if (unsuffixedTarget.shared) {
    const registeredDatabases = readSessionStoreRegistryRows(
      options.registeredDatabases,
      options.env,
      options.onReadError,
    );
    const registeredOwners = resolveRegisteredOwners(
      unsuffixedTarget.path,
      registeredDatabases,
      options.isSameDatabasePath ?? createOpenClawAgentDatabasePathMatcher(),
    );
    let databaseOwner: string | undefined;
    if (registeredOwners.length === 1) {
      // Registry precedence makes inspection redundant, but filesystem errors still propagate.
      hasFilesystemEntry(unsuffixedTarget.path, options.onReadError);
    } else {
      databaseOwner = resolveDatabaseOwner(
        unsuffixedTarget.path,
        options.readCandidates,
        options.onReadError,
      );
    }
    const configuredDefaultAgentId = normalizeAgentId(
      options.defaultAgentId ?? LEGACY_IMPLICIT_AGENT_ID,
    );
    const ownerAgentId =
      (registeredOwners.length === 1 ? registeredOwners[0] : undefined) ??
      databaseOwner ??
      configuredDefaultAgentId;
    return {
      ...(ownerAgentId ? { agentId: ownerAgentId } : {}),
      path: unsuffixedTarget.path,
      // Exact locators are shared session stores: scoped keys partition rows inside one file.
      // The physical schema owner must never turn the first caller into the store's sole owner.
      shared: true,
      ...(registeredOwners.length === 1
        ? { ownerSource: "database-registry" as const }
        : databaseOwner
          ? { ownerSource: "database-path" as const }
          : registeredOwners.length > 1
            ? { ownerSource: "ambiguous-registry" as const }
            : { ownerSource: "configured-default" as const }),
    };
  }
  return resolveCustomStoreSqlitePath({ unsuffixedPath: unsuffixedTarget.path, options });
}

/** Lists durable owners recorded in the fixed store's bounded SQLite sibling family. */
export function listDurableSqliteTargetOwnersForSessionStorePath(storePath: string): string[] {
  const owners = new Set<string>();
  for (const candidatePath of listSqliteTargetCandidatePathsForSessionStorePath(storePath)) {
    const owner = resolveDatabaseOwner(candidatePath);
    if (owner) {
      owners.add(owner);
    }
  }
  return [...owners];
}

/** List inspection candidates without opening stores or assigning writable ownership. */
export function listSqliteTargetCandidatePathsForSessionStorePath(storePath: string): string[] {
  const unsuffixedTarget = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
  if (unsuffixedTarget.agentId || unsuffixedTarget.shared) {
    return [unsuffixedTarget.path];
  }
  const directory = path.dirname(unsuffixedTarget.path);
  const baseName = path.basename(unsuffixedTarget.path, ".sqlite");
  const candidateNames = new Set([path.basename(unsuffixedTarget.path)]);
  try {
    for (const fileName of readdirSync(directory)) {
      const databaseName = fileName.replace(/-(?:wal|shm|journal)$/u, "");
      if (databaseName.startsWith(`${baseName}.`) && databaseName.endsWith(".sqlite")) {
        candidateNames.add(databaseName);
      }
    }
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  }
  return [...candidateNames].map((fileName) => path.join(directory, fileName));
}

/** Lists the logical store's unsuffixed target plus durable owned partitions. */
export function listDurableSqliteTargetPathsForSessionStorePath(storePath: string): string[] {
  const candidates = listSqliteTargetCandidatePathsForSessionStorePath(storePath);
  return candidates.filter(
    (candidatePath, index) => index === 0 || resolveDatabaseOwner(candidatePath) !== undefined,
  );
}

/** Extracts the agent id from the canonical per-agent SQLite database path. */
function resolveAgentIdFromSqliteDatabasePath(databasePath: string): string | undefined {
  if (path.basename(databasePath) !== "openclaw-agent.sqlite") {
    return undefined;
  }
  const agentDbDir = path.dirname(databasePath);
  if (path.basename(agentDbDir) !== "agent") {
    return undefined;
  }
  const agentDir = path.dirname(agentDbDir);
  if (path.basename(path.dirname(agentDir)) !== "agents") {
    return undefined;
  }
  return normalizeAgentId(path.basename(agentDir));
}
