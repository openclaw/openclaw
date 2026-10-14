import process from "node:process";
import { format } from "node:util";
import { expectDefined } from "@openclaw/normalization-core/expect";
import {
  detectCurrentSqliteCapabilities,
  nodeRuntimeFailure,
  nodeRuntimeNote,
  type SqliteCapabilities,
} from "../../node-sqlite.mjs";
import {
  canRunOpenClawNodeDiagnostics,
  classifyUnsupportedNodeCommand,
  formatUnsupportedNodeDiagnosticWarning,
  isNodeVersionAtLeast,
  parseNodeReleaseVersion,
  type NodeReleaseVersion,
} from "../../node-version.mjs";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import { ensureSqliteLibrarySelected } from "./bun-sqlite-library.js";
import { isSqliteWalResetSafeVersion } from "./sqlite-runtime-version.js";

export { isSupportedOpenClawNodeVersion as isSupportedNodeVersion } from "../../node-version.mjs";

type RuntimeKind = "bun" | "node" | "unknown";

const MINIMUM_BUN_VERSION: NodeReleaseVersion = { major: 1, minor: 4, patch: 0 };

const ENGINE_CLAUSE_RE = /^\s*>=\s*v?(\d+\.\d+\.\d+)(?:\s+<\s*v?(\d+(?:\.\d+\.\d+)?))?\s*$/i;

type RuntimeDetails = {
  kind: RuntimeKind;
  version: string | null;
  execPath: string | null;
  pathEnv: string;
  hasNodeSqlite: boolean;
  sqliteVersion: string | null;
  sqliteSelectionError?: string;
  sqliteProbe?: SqliteCapabilities;
};

const SEMVER_RE = /(\d+)\.(\d+)\.(\d+)/;
let diagnosticWarningPrinted = false;

/** Parses the first major/minor/patch triple from a runtime or package version label. */
export function parseSemver(version: string | null): NodeReleaseVersion | null {
  if (!version) {
    return null;
  }
  const match = version.match(SEMVER_RE);
  if (!match) {
    return null;
  }
  const [, major, minor, patch] = match;
  return {
    major: Number.parseInt(expectDefined(major, "runtime guard major"), 10),
    minor: Number.parseInt(expectDefined(minor, "runtime guard minor"), 10),
    patch: Number.parseInt(expectDefined(patch, "runtime guard patch"), 10),
  };
}

export async function detectRuntime(): Promise<RuntimeDetails> {
  const bunVersion = process.versions?.bun;
  const details: RuntimeDetails = {
    kind: bunVersion ? "bun" : process.versions?.node ? "node" : "unknown",
    version: bunVersion ?? process.versions?.node ?? null,
    execPath: process.execPath ?? null,
    pathEnv: process.env.PATH ?? "(not set)",
    hasNodeSqlite: false,
    sqliteVersion: null,
    sqliteSelectionError: undefined,
    sqliteProbe: undefined,
  };
  try {
    ensureSqliteLibrarySelected();
  } catch (error) {
    details.sqliteSelectionError = error instanceof Error ? error.message : String(error);
    return details;
  }
  try {
    const probe = await detectCurrentSqliteCapabilities();
    details.hasNodeSqlite = probe.available;
    details.sqliteVersion = probe.version;
    details.sqliteProbe = probe;
  } catch {
    return details;
  }
  return details;
}

function runtimeSatisfies(details: RuntimeDetails): boolean {
  if (details.sqliteSelectionError) {
    return false;
  }
  if (details.kind === "node") {
    return Boolean(
      details.sqliteProbe && !nodeRuntimeFailure(details.version, details.sqliteProbe),
    );
  }
  if (details.kind === "bun") {
    return (
      isSupportedBunVersion(details.version) &&
      details.hasNodeSqlite &&
      details.sqliteVersion !== null &&
      isSqliteWalResetSafeVersion(details.sqliteVersion)
    );
  }
  return false;
}

export async function isCurrentRuntimeSupported(): Promise<boolean> {
  return runtimeSatisfies(await detectRuntime());
}

export function isSupportedBunVersion(version: string | null): boolean {
  return isNodeVersionAtLeast(parseSemver(version), MINIMUM_BUN_VERSION);
}

/** Returns whether a Node version satisfies a supported engine range, or null if unsupported. */
export function nodeVersionSatisfiesEngine(
  version: string | null,
  engine: string | null,
): boolean | null {
  if (!engine) {
    return null;
  }
  const parsed = parseNodeReleaseVersion(version);
  if (!parsed) {
    return false;
  }

  const clauses = engine.split("||");
  let satisfied = false;
  for (const clause of clauses) {
    const match = clause.match(ENGINE_CLAUSE_RE);
    if (!match) {
      return null;
    }
    const clauseMinimum = parseSemver(match[1] ?? null);
    const upperRaw = match[2];
    const upper = upperRaw
      ? parseSemver(upperRaw.includes(".") ? upperRaw : `${upperRaw}.0.0`)
      : null;
    if (!clauseMinimum || (upperRaw && !upper)) {
      return null;
    }
    if (
      isNodeVersionAtLeast(parsed, clauseMinimum) &&
      (!upper || !isNodeVersionAtLeast(parsed, upper))
    ) {
      satisfied = true;
    }
  }
  return satisfied;
}

export async function assertSupportedRuntime(
  providedRuntime?: RuntimeEnv,
  providedDetails?: RuntimeDetails,
  argv?: readonly string[],
  emitDiagnosticWarning = true,
  recoveryEnv?: NodeJS.ProcessEnv,
): Promise<void> {
  const details = providedDetails ?? (await detectRuntime());
  const writeNotice = (message: string) =>
    providedRuntime ? providedRuntime.error(message) : process.stderr.write(`${message}\n`);
  if (runtimeSatisfies(details)) {
    const note =
      details.kind === "node" && details.sqliteProbe
        ? nodeRuntimeNote(details.version, details.sqliteProbe)
        : null;
    if (note) {
      writeNotice(note);
    }
    return;
  }
  // Only startup callers with a pre-dotenv snapshot may select another runtime.
  if (details.kind === "node" && argv && recoveryEnv) {
    const { recoverNodeRuntime } = await import("../../node-runtime-recovery.mjs");
    if (await recoverNodeRuntime({ env: recoveryEnv })) {
      // The replacement finished; this unsupported parent must not continue startup.
      throw new ExitError(Number(process.exitCode ?? 0));
    }
  }
  if (
    details.kind === "node" &&
    canRunOpenClawNodeDiagnostics(details.version, details.hasNodeSqlite) &&
    argv &&
    classifyUnsupportedNodeCommand(argv)
  ) {
    if (emitDiagnosticWarning && !diagnosticWarningPrinted) {
      const warning = formatUnsupportedNodeDiagnosticWarning(details.version);
      writeNotice(warning);
      diagnosticWarningPrinted = true;
    }
    return;
  }
  let runtime = providedRuntime;
  // Healthy starts need no diagnostic graph; a supplied runtime already owns its error sink.
  if (!runtime) {
    const { formatConsoleDiagnosticBlock } = await import("../logging/json-console-line.js");
    runtime = {
      log: (...args) => console.log(...args),
      error: (...args) => {
        const message = format(...args);
        process.stderr.write(
          formatConsoleDiagnosticBlock({ level: "error", message: `${message}\n` }),
        );
      },
      exit: (code) => {
        throw new ExitError(code);
      },
    };
  }

  const versionLabel = details.version ?? "unknown";
  const runtimeLabel =
    details.kind === "unknown" ? "unknown runtime" : `${details.kind} ${versionLabel}`;
  const execLabel = details.execPath ?? "unknown";
  if (details.sqliteSelectionError) {
    runtime.error(
      `${details.sqliteSelectionError}\nDetected: ${runtimeLabel} (exec: ${execLabel}).`,
    );
    runtime.exit(1);
    return;
  }
  const requirement =
    details.kind === "bun"
      ? "openclaw requires Bun 1.4 or newer with WAL-reset-safe node:sqlite (SQLite 3.51.3+ or a patched 3.50.x/3.44.x release)."
      : (details.sqliteProbe && nodeRuntimeFailure(details.version, details.sqliteProbe)) ||
        "openclaw requires Node >=24.16.0 <25, or >=26.1.0.";
  const retryHint =
    details.kind === "bun"
      ? "Upgrade Bun or run OpenClaw with a supported Node release."
      : "Upgrade Node and re-run openclaw.";

  runtime.error(
    [
      requirement,
      `Detected: ${runtimeLabel} (exec: ${execLabel}).`,
      ...(details.kind === "bun"
        ? [`Detected SQLite: ${details.sqliteVersion ?? "unavailable"}.`]
        : []),
      `PATH searched: ${details.pathEnv}`,
      details.kind === "bun"
        ? "Install Bun: https://bun.com/docs/installation"
        : "Install Node: https://nodejs.org/en/download",
      retryHint,
    ].join("\n"),
  );
  runtime.exit(1);
}
