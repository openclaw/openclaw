import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type ExistingSchemaScope = { path: string; canonicalPath: string; active: boolean };
const schemaPolicies = resolveGlobalSingleton(
  Symbol.for("openclaw.stateDatabaseSchemaPolicies"),
  () => ({
    scopes: new AsyncLocalStorage<ExistingSchemaScope>(),
    existingDatabases: new WeakMap<DatabaseSync, string>(),
  }),
);

function canonicalPath(pathname: string): string {
  const resolved = path.resolve(pathname);
  try {
    return realpathSync.native(resolved);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return resolved;
    }
    throw error;
  }
}

/** A managed runtime consumes this exact schema without taking over its repair owner. */
export function withExistingOpenClawStateSchema<T>(
  options: { path: string },
  run: () => Promise<T>,
): Promise<T>;
export function withExistingOpenClawStateSchema<T>(options: { path: string }, run: () => T): T;
export function withExistingOpenClawStateSchema<T>(
  options: { path: string },
  run: () => T | Promise<T>,
): T | Promise<T> {
  getExistingOpenClawStateSchemaPath();
  const parent = schemaPolicies.scopes.getStore();
  const scope = {
    path: path.resolve(options.path),
    canonicalPath: canonicalPath(options.path),
    active: true,
  };
  if (parent && parent.canonicalPath !== scope.canonicalPath) {
    throw new Error("Existing shared-state schema admission cannot change its database path.");
  }
  try {
    const result = schemaPolicies.scopes.run(scope, run);
    if (isPromiseLike<T>(result)) {
      return Promise.resolve(result).finally(() => {
        scope.active = false;
      });
    }
    scope.active = false;
    return result;
  } catch (error) {
    scope.active = false;
    throw error;
  }
}

function assertSchemaScopeActive(scope: ExistingSchemaScope | undefined): void {
  if (scope && !scope.active) {
    throw new Error("Existing shared-state schema admission has ended.");
  }
}

export function getExistingOpenClawStateSchemaPath(): string | undefined {
  const scope = schemaPolicies.scopes.getStore();
  assertSchemaScopeActive(scope);
  return scope?.path;
}

/** Admit this source once; retained reads only need the original scope's live lifetime. */
export function captureOpenClawStateSchemaReadAdmission(pathname: string) {
  const scope = schemaPolicies.scopes.getStore();
  if (!scope) {
    return undefined;
  }
  isExistingOpenClawStateSchema(pathname);
  return { path: scope.path, assertCurrent: () => assertSchemaScopeActive(scope) };
}

/** Check supplied and cached handles before exposing them to another admission policy. */
export function isExistingOpenClawStateSchema(pathname: string, database?: DatabaseSync): boolean {
  const scopedPath = getExistingOpenClawStateSchemaPath();
  const scope = schemaPolicies.scopes.getStore();
  const admittedPath = database && schemaPolicies.existingDatabases.get(database);
  const resolvedPath = path.resolve(pathname);
  const existing =
    scopedPath !== undefined &&
    (scopedPath === resolvedPath ||
      scope?.canonicalPath === resolvedPath ||
      scope?.canonicalPath === canonicalPath(resolvedPath));
  if (scopedPath && !existing) {
    throw new Error(
      `Existing shared-state schema admission is bound to ${scopedPath}, not ${pathname}.`,
    );
  }
  if (admittedPath && (!existing || admittedPath !== scope?.canonicalPath)) {
    throw new Error(
      `Shared-state database ${pathname} was admitted without schema repair; close its existing handle before ordinary admission.`,
    );
  }
  return existing;
}

export function recordExistingOpenClawStateSchemaDatabase(
  database: DatabaseSync,
  pathname: string,
): void {
  const scope = schemaPolicies.scopes.getStore();
  if (!scope || !isExistingOpenClawStateSchema(pathname, database)) {
    throw new Error("Existing shared-state schema admission requires its active path scope.");
  }
  schemaPolicies.existingDatabases.set(database, scope.canonicalPath);
}

/** The cache owns the handle inventory, including owners retained after failed cleanup. */
export function assertExistingOpenClawStateSchemaCacheAdmission(
  pathname: string,
  cache: {
    cachedDatabases: ReadonlyMap<string, { db: DatabaseSync }>;
    retainedDatabaseHandles: ReadonlyMap<DatabaseSync, { db: DatabaseSync }>;
  },
): void {
  const scopedPath = getExistingOpenClawStateSchemaPath();
  const scope = schemaPolicies.scopes.getStore();
  const requested = path.resolve(pathname);
  let resolved =
    scope && (scopedPath === requested || scope.canonicalPath === requested)
      ? scope.canonicalPath
      : undefined;
  for (const databases of [cache.cachedDatabases, cache.retainedDatabaseHandles]) {
    for (const { db } of databases.values()) {
      const admittedPath = schemaPolicies.existingDatabases.get(db);
      if (admittedPath && db.isOpen) {
        resolved ??= canonicalPath(pathname);
        if (admittedPath === resolved) {
          isExistingOpenClawStateSchema(pathname, db);
        }
      }
    }
  }
}

export function assertOpenClawStateSchemaRepairAllowed(pathname: string): void {
  if (isExistingOpenClawStateSchema(pathname)) {
    throw new Error(
      `Shared-state schema repair is owned by the existing installation at ${pathname}; update that installation before retrying the managed node.`,
    );
  }
}
