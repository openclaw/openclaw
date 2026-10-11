import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { posix } from "node:path";
import { getEnvironmentData, isMainThread, setEnvironmentData } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { probeSqliteNativeClose } from "./bun-sqlite-close-probe.js";
import { parseDiagnosticEnvFlags } from "./diagnostic-flags-env.js";
import { isSqliteWalResetSafeVersion } from "./sqlite-runtime-version.js";

export type SqliteLibrarySelection =
  | { source: "runtime"; ignoredOverride?: string }
  | {
      source: "env" | "discovered";
      path: string;
      version: string;
      extensionLoadingSupported: true;
    };

type SelectionOptions = { explicitPath?: string };
type LibraryProbe = { version: string; extensionLoadingSupported: boolean };
const WORKER_SELECTION_KEY = "openclaw.bunSqliteLibrarySelection";
const WORKER_CAPABILITIES_KEY = "openclaw.sqliteRuntimeCapabilities";
export const SQLITE_NATIVE_RUNTIME_ADMISSION_KEY = "openclaw.sqliteNativeRuntimeAdmission";
export const SQLITE_CANONICAL_DEFINITIONS_KEY =
  "openclaw.agentCanonicalValidationSchemaDefinitions";
export const SQLITE_EXPECTED_SCHEMA_CONTRACTS_KEY = "openclaw.sqliteExpectedSchemaContracts.v1";

type SqliteCloseProbeResult = Awaited<ReturnType<typeof probeSqliteNativeClose>>;
export type SqliteRuntimeCapabilities = SqliteCloseProbeResult & Readonly<{ decided: boolean }>;

function createCapabilities(select: () => unknown) {
  let decision: SqliteRuntimeCapabilities | undefined;
  let initialization: Promise<SqliteRuntimeCapabilities> | undefined;
  let earlyTopologyOwners = 0;
  const pending = Object.freeze({
    explicitSqliteCloseReleasesNativeResources: false,
    decided: false,
    reason: "SQLite close capability has not been decided",
  });
  function decide(value: SqliteRuntimeCapabilities): SqliteRuntimeCapabilities {
    if (!decision) {
      decision = Object.freeze(value);
      setEnvironmentData(WORKER_CAPABILITIES_KEY, decision);
      if (decision.explicitSqliteCloseReleasesNativeResources && earlyTopologyOwners > 0) {
        process.emitWarning(
          `SQLite close became capable after ${earlyTopologyOwners} topology owners were created; those owners remain conservative`,
          { code: "SQLITE_EARLY_TOPOLOGY" },
        );
      }
    }
    return decision;
  }
  function conservative(reason: string): SqliteRuntimeCapabilities {
    return { explicitSqliteCloseReleasesNativeResources: false, decided: true, reason };
  }
  function settled(): SqliteRuntimeCapabilities | undefined {
    if (decision) {
      return decision;
    }
    if (!process.versions.bun) {
      return decide({
        explicitSqliteCloseReleasesNativeResources: true,
        decided: true,
        reason: "Node runtime",
      });
    }
    if (process.platform === "win32") {
      return decide(conservative("Bun Windows native-close conformance is not qualified"));
    }
    if (!isMainThread) {
      return decide({
        ...pending,
        reason: "Parent did not complete SQLite close admission",
        // SAFETY: This owner publishes the structured-cloned fact inherited by workers.
        ...(getEnvironmentData(WORKER_CAPABILITIES_KEY) as SqliteRuntimeCapabilities | undefined),
      });
    }
    return undefined;
  }
  return {
    get() {
      return settled() ?? pending;
    },
    capture() {
      const fact = settled() ?? pending;
      if (!fact.decided) {
        earlyTopologyOwners += 1;
      }
      return fact.explicitSqliteCloseReleasesNativeResources;
    },
    initialize() {
      initialization ??= (async () => {
        select();
        const ready = settled();
        if (ready) {
          return ready;
        }
        try {
          // Wildcard diagnostics must not change the native retirement policy.
          if (
            parseDiagnosticEnvFlags(process.env.OPENCLAW_DIAGNOSTICS).flags.some(
              (flag) => flag.toLowerCase() === "sqlite.close.conservative",
            )
          ) {
            return decide(
              conservative("SQLite close optimization disabled by internal diagnostic flag"),
            );
          }
          const { probeSqliteNativeClose } = await import("./bun-sqlite-close-probe.js");
          return decide({ ...(await probeSqliteNativeClose()), decided: true });
        } catch (error) {
          return decide(conservative(`SQLite close check failed: ${String(error)}`));
        }
      })();
      return initialization;
    },
  };
}

// Bun is optional: describe only the FFI symbols used at this native boundary.
type BunFfi = {
  FFIType: { cstring: number; i32: number };
  dlopen: (
    path: string,
    symbols: Record<string, { args: number[]; returns: number }>,
  ) => {
    symbols: {
      sqlite3_libversion: () => { toString(): string };
      sqlite3_compileoption_used: (option: Buffer) => number;
    };
    close: () => void;
  };
};

function probeLibrary(path: string): LibraryProbe {
  const require = createRequire(import.meta.url);
  // SAFETY: Called only on Bun; this models its FFI module and the two requested SQLite symbols.
  const { dlopen, FFIType } = require("bun:ffi") as BunFfi;
  const library = dlopen(path, {
    sqlite3_libversion: { args: [], returns: FFIType.cstring },
    sqlite3_compileoption_used: { args: [FFIType.cstring], returns: FFIType.i32 },
  });
  try {
    return {
      version: String(library.symbols.sqlite3_libversion()),
      extensionLoadingSupported:
        library.symbols.sqlite3_compileoption_used(Buffer.from("OMIT_LOAD_EXTENSION\0")) === 0,
    };
  } finally {
    library.close();
  }
}

function selectLibrary(path: string): void {
  const require = createRequire(import.meta.url);
  // SAFETY: Called only on macOS Bun, whose Database exposes the process-wide library selector.
  const { Database } = require("bun:sqlite") as {
    Database: { setCustomSQLite: (path: string) => void };
  };
  Database.setCustomSQLite(path);
}

function createSelector() {
  let selection: SqliteLibrarySelection | undefined;
  let failure: Error | undefined;
  return (options: SelectionOptions = {}): SqliteLibrarySelection => {
    if (failure) {
      throw failure;
    }
    if (selection) {
      return selection;
    }
    const override =
      options.explicitPath ?? (process.env.OPENCLAW_SQLITE_LIBRARY?.trim() || undefined);
    if (!process.versions.bun || process.platform !== "darwin") {
      selection = override
        ? { source: "runtime", ignoredOverride: "OPENCLAW_SQLITE_LIBRARY requires Bun on macOS" }
        : { source: "runtime" };
      return selection;
    }
    const prefix = process.env.HOMEBREW_PREFIX?.trim();
    const candidates =
      override !== undefined
        ? [override]
        : [
            ...new Set([
              ...(prefix ? [posix.join(prefix, "opt/sqlite/lib/libsqlite3.dylib")] : []),
              "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
              "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
              "/opt/local/lib/libsqlite3.dylib",
            ]),
          ];
    for (const path of candidates) {
      let probe: LibraryProbe;
      try {
        // dlopen decides loadability: Apple's SQLite lives in the dyld shared cache with no
        // file on disk, so a stat-first check would hide its real defect (OMIT_LOAD_EXTENSION).
        try {
          probe = probeLibrary(path);
        } catch (error) {
          throw existsSync(path) ? error : new Error("missing file", { cause: error });
        }
        if (!isSqliteWalResetSafeVersion(probe.version)) {
          throw new Error(`SQLite version ${probe.version} below the WAL safety floor`);
        }
        if (!probe.extensionLoadingSupported) {
          throw new Error("built with SQLITE_OMIT_LOAD_EXTENSION");
        }
      } catch (error) {
        if (override === undefined) {
          continue;
        }
        failure = selectionError(path, error);
        throw failure;
      }
      try {
        // Never try another candidate after committing: Bun's hook is one-shot, even on failure.
        // Discovery trusts the user-writable prefix like the Homebrew Bun binary itself;
        // an override is operator-specified code, like memory.search.store.vector.extensionPath.
        selectLibrary(path);
      } catch (error) {
        failure = selectionError(path, error);
        throw failure;
      }
      selection = {
        source: override === undefined ? "discovered" : "env",
        path,
        version: probe.version,
        extensionLoadingSupported: true,
      };
      return selection;
    }
    selection = { source: "runtime" };
    return selection;
  };
}

function selectionError(path: string, error: unknown): Error {
  return new Error(
    `Cannot use SQLite library ${path}: ${error instanceof Error ? error.message : String(error)}. ` +
      "Fix or unset OPENCLAW_SQLITE_LIBRARY; install a supported library with brew install sqlite.",
    { cause: error },
  );
}

function inheritedSelection(): SqliteLibrarySelection | undefined {
  const value: unknown = getEnvironmentData(WORKER_SELECTION_KEY);
  if (value === undefined) {
    return undefined;
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const source = "source" in value ? value.source : undefined;
    if (source === "runtime") {
      return { source: "runtime" };
    }
    const path = "path" in value ? value.path : undefined;
    const version = "version" in value ? value.version : undefined;
    const extensionLoadingSupported =
      "extensionLoadingSupported" in value ? value.extensionLoadingSupported : undefined;
    if (
      (source === "env" || source === "discovered") &&
      typeof path === "string" &&
      typeof version === "string" &&
      extensionLoadingSupported === true
    ) {
      return {
        source,
        path,
        version,
        extensionLoadingSupported: true,
      };
    }
  }
  throw new Error("Invalid inherited SQLite library selection");
}

function createRuntimeSelector(): ReturnType<typeof createSelector> {
  const isBun = Boolean(process.versions.bun);
  const sharedLibrary = isBun && process.platform === "darwin";
  const inherited = sharedLibrary && !isMainThread ? inheritedSelection() : undefined;
  const select = createSelector();
  let published = false;
  return (options?: SelectionOptions) => {
    const selection = inherited ?? select(options);
    if (sharedLibrary && isMainThread && !published) {
      // Bun's library hook is process-wide; new workers inherit the completed owner's fact.
      setEnvironmentData(WORKER_SELECTION_KEY, Object.freeze({ ...selection }));
      published = true;
    }
    return selection;
  };
}

function runtimeSelector(): ReturnType<typeof createSelector> & {
  capabilities?: ReturnType<typeof createCapabilities>;
} {
  return resolveGlobalSingleton(
    Symbol.for("openclaw.bunSqliteLibrarySelection"),
    createRuntimeSelector,
  );
}

function capabilities() {
  // Retained updater generations still call this same library-selection owner.
  const select = runtimeSelector();
  return (select.capabilities ??= createCapabilities(select));
}

export function getSqliteRuntimeCapabilities(): SqliteRuntimeCapabilities {
  return capabilities().get();
}

/** A topology owner keeps this snapshot for placement and paired native retirement. */
export function captureSqliteWorkerClosePolicy(): boolean {
  return capabilities().capture();
}

/** Retained supervisors forward the caller's current facts when creating each descendant. */
export function captureSqliteWorkerEnvironmentData(): ReadonlyArray<
  readonly [string, Parameters<typeof setEnvironmentData>[1]]
> {
  return [
    [WORKER_SELECTION_KEY, ensureSqliteLibrarySelected()],
    [WORKER_CAPABILITIES_KEY, getSqliteRuntimeCapabilities()],
    // Opaque owner facts include absence, which clears a retained carrier's previous snapshot.
    [SQLITE_NATIVE_RUNTIME_ADMISSION_KEY, getEnvironmentData(SQLITE_NATIVE_RUNTIME_ADMISSION_KEY)],
    [SQLITE_CANONICAL_DEFINITIONS_KEY, getEnvironmentData(SQLITE_CANONICAL_DEFINITIONS_KEY)],
    [
      SQLITE_EXPECTED_SCHEMA_CONTRACTS_KEY,
      getEnvironmentData(SQLITE_EXPECTED_SCHEMA_CONTRACTS_KEY),
    ],
  ];
}

/** Await at runtime admission, before any consumer chooses a worker topology. */
export function initializeSqliteRuntimeCapabilities(): Promise<SqliteRuntimeCapabilities> {
  return capabilities().initialize();
}

/** Select once, before any SQLite open; shared across CLI and bundled SDK module graphs. */
export function ensureSqliteLibrarySelected(options?: SelectionOptions): SqliteLibrarySelection {
  return runtimeSelector()(options);
}
