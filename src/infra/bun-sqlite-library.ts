import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { posix } from "node:path";
import { getEnvironmentData, isMainThread, setEnvironmentData } from "node:worker_threads";
import { resolveStandaloneSidecarRoot } from "../../cli-invocation.mjs";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { probeSqliteNativeClose } from "./bun-sqlite-close-probe.js";
import { probeBunSqliteLibrary } from "./bun-sqlite-library-probe.js";
import { PROCESS_MACHINE_IDENTITY_KEY } from "./current-machine-identity.js";
import { parseDiagnosticEnvFlags } from "./diagnostic-flags-env.js";
import { SQLITE_DATABASE_ADMISSIONS_KEY } from "./sqlite-database-admission-key.js";
import { isSqliteWalResetSafeVersion } from "./sqlite-runtime-version.js";

export type SqliteLibrarySelection =
  | { source: "runtime"; ignoredOverride?: string }
  | {
      source: "env" | "bundled" | "discovered";
      path: string;
      version: string;
      extensionLoadingSupported: true;
    };

type SelectionOptions = { explicitPath?: string; standaloneRoot?: string };
type LibraryProbe = { version: string; extensionLoadingSupported: boolean };
const WORKER_SELECTION_KEY = "openclaw.bunSqliteLibrarySelection";
const WORKER_CAPABILITIES_KEY = "openclaw.sqliteRuntimeCapabilities";
export const SQLITE_NATIVE_RUNTIME_ADMISSION_KEY = "openclaw.sqliteNativeRuntimeAdmission";

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
    const standaloneRoot = options.standaloneRoot ?? resolveStandaloneSidecarRoot();
    const bundled =
      override === undefined && standaloneRoot !== undefined
        ? posix.join(standaloneRoot, "lib/libsqlite3.dylib")
        : undefined;
    const prefix = process.env.HOMEBREW_PREFIX?.trim();
    const candidates =
      override !== undefined
        ? [override]
        : [
            ...new Set([
              ...(bundled ? [bundled] : []),
              ...(prefix ? [posix.join(prefix, "opt/sqlite/lib/libsqlite3.dylib")] : []),
              "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
              "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
              "/opt/local/lib/libsqlite3.dylib",
            ]),
          ];
    const unusable: string[] = [];
    for (const path of candidates) {
      const source = override !== undefined ? "env" : path === bundled ? "bundled" : "discovered";
      let probe: LibraryProbe;
      let present = true;
      try {
        // Loading decides availability: Apple's SQLite lives in the dyld shared cache with no
        // file on disk, so a stat-first check would hide its real defect (OMIT_LOAD_EXTENSION).
        try {
          probe = probeBunSqliteLibrary(path);
        } catch (error) {
          present = existsSync(path);
          throw present ? error : new Error("missing file", { cause: error });
        }
        if (!isSqliteWalResetSafeVersion(probe.version)) {
          throw new Error(`SQLite version ${probe.version} below the WAL safety floor`);
        }
        if (!probe.extensionLoadingSupported) {
          throw new Error("built with SQLITE_OMIT_LOAD_EXTENSION");
        }
      } catch (error) {
        if (override === undefined) {
          // Absent candidates are ordinary; present ones explain the refusal below.
          if (present || path === bundled) {
            unusable.push(`${path} (${error instanceof Error ? error.message : String(error)})`);
          }
          continue;
        }
        failure = selectionError(path, error, source === "bundled");
        throw failure;
      }
      try {
        // Never try another candidate after committing: Bun's hook is one-shot, even on failure.
        // Discovery trusts the user-writable prefix like the Homebrew Bun binary itself;
        // an override is operator-specified code, like memory.search.store.vector.extensionPath.
        selectLibrary(path);
      } catch (error) {
        failure = selectionError(path, error, source === "bundled");
        throw failure;
      }
      selection = {
        source,
        path,
        version: probe.version,
        extensionLoadingSupported: true,
      };
      return selection;
    }
    // Bun's macOS runtime library is Apple's patched system SQLite. Its read-only
    // connections fail same-process RESERVED locks and sidecar-less WAL opens.
    failure = new Error(
      `No supported SQLite library for Bun on macOS (${process.arch})` +
        (unusable.length > 0 ? `; unusable: ${unusable.join(", ")}` : "") +
        ". Apple's system SQLite fails OpenClaw's read-only database connections. " +
        (bundled
          ? "Rebuild or replace the complete standalone artifact to restore its bundled SQLite library. "
          : "") +
        `Install one with brew install sqlite, or set OPENCLAW_SQLITE_LIBRARY to a libsqlite3.dylib built for ${process.arch}.`,
    );
    throw failure;
  };
}

function selectionError(path: string, error: unknown, bundled = false): Error {
  const guidance = bundled
    ? "Rebuild or replace the complete standalone artifact (openclaw and runtime/), or set OPENCLAW_SQLITE_LIBRARY to a supported library."
    : "Fix or unset OPENCLAW_SQLITE_LIBRARY; install a supported library with brew install sqlite.";
  return new Error(
    `Cannot use ${bundled ? "bundled " : ""}SQLite library ${path}: ${error instanceof Error ? error.message : String(error)}. ${guidance}`,
    { cause: error },
  );
}

function createRuntimeSelector(): ReturnType<typeof createSelector> {
  const isBun = Boolean(process.versions.bun);
  const sharedLibrary = isBun && process.platform === "darwin";
  let inherited: SqliteLibrarySelection | undefined;
  if (sharedLibrary && !isMainThread) {
    // SAFETY: Only this selector publishes the chosen fact; workers inherit Node's structured clone.
    inherited = getEnvironmentData(WORKER_SELECTION_KEY) as SqliteLibrarySelection | undefined;
  }
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
export function captureSqliteWorkerEnvironmentData(
  databaseAdmissions = getEnvironmentData(SQLITE_DATABASE_ADMISSIONS_KEY),
): ReadonlyArray<readonly [string, Parameters<typeof setEnvironmentData>[1]]> {
  return [
    [WORKER_SELECTION_KEY, ensureSqliteLibrarySelected()],
    [WORKER_CAPABILITIES_KEY, getSqliteRuntimeCapabilities()],
    // Opaque owner facts include absence, which clears a retained carrier's previous snapshot.
    [SQLITE_NATIVE_RUNTIME_ADMISSION_KEY, getEnvironmentData(SQLITE_NATIVE_RUNTIME_ADMISSION_KEY)],
    [SQLITE_DATABASE_ADMISSIONS_KEY, databaseAdmissions],
    [PROCESS_MACHINE_IDENTITY_KEY, getEnvironmentData(PROCESS_MACHINE_IDENTITY_KEY)],
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
