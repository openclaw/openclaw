import { isUtf8 } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import { normalizeSupportDiagnosticErrorCode } from "../logging/diagnostic-support-redaction.js";
import { runCommandBuffered } from "../process/exec.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../utils/absolute-deadline.js";
import { isPathInside } from "./fs-safe.js";
import { hasNodeErrorCode } from "./path-guards.js";

export const PKG_INSPECTION_TIMEOUT_MS = 30_000;

type InspectionOperation =
  | "pkg query"
  | "lstat"
  | "realpath"
  | "directory resolution"
  | "path inspection";
type InspectionDiagnostic = { operation: InspectionOperation } & (
  | { code?: string }
  | { budgetMs: number }
);

export class FreeBsdPkgOwnershipError extends Error {
  constructor(
    readonly reason: "pkg-owned-install" | "pkg-ownership-unavailable",
    source: "database" | "paths" = "database",
    diagnostic?: InspectionDiagnostic,
  ) {
    const code =
      diagnostic && "code" in diagnostic
        ? normalizeSupportDiagnosticErrorCode(diagnostic.code)
        : undefined;
    // Facts truncate messages to 200 characters; keep the safe owning failure first.
    const prefix = !diagnostic
      ? ""
      : "budgetMs" in diagnostic
        ? `FreeBSD pkg inspection exhausted its shared ${diagnostic.budgetMs} ms budget during ${diagnostic.operation}. `
        : `FreeBSD pkg inspection failed during ${diagnostic.operation}${code ? ` (${code})` : ""}. `;
    super(
      prefix +
        (reason === "pkg-owned-install"
          ? "This installation contains files owned by FreeBSD pkg. Update it through pkg or the Ports deployment that owns it; openclaw update will not replace package-owned files."
          : source === "paths"
            ? "FreeBSD pkg paths could not be inspected completely. Check access to the registered package directories and installation paths, and resolve any inspection timeout before retrying."
            : "FreeBSD pkg ownership could not be verified. Restore access to the active pkg database and configuration, then retry."),
    );
    this.name = "FreeBsdPkgOwnershipError";
  }
}

export type FreeBsdPkgOwnershipInspection = {
  assertUnowned: (root: string | null | undefined) => Promise<void>;
  assertEntryUnowned: (file: string) => Promise<void>;
};

async function readPkgFiles(timeoutMs: number): Promise<string[]> {
  // -N prevents the base-system pkg launcher from bootstrapping. Pin the builtin
  // query: pkg expands aliases once, and plugin initialization precedes dispatch.
  const result = await runCommandBuffered(["/usr/sbin/pkg", "-N", "query", "-a", "%Fp"], {
    timeoutMs,
    env: { ALIAS: "query=query", PKG_ENABLE_PLUGINS: "no" },
    maxOutputBytes: { stdout: 16 * 1024 * 1024, stderr: 64 * 1024 },
  });
  // pkg can report a config read error without a failing exit. Only a complete,
  // silent query proves non-ownership; neither truncated output nor exit 1 does.
  if (
    result.termination !== "exit" ||
    result.code !== 0 ||
    result.stderr.length !== 0 ||
    !isUtf8(result.stdout)
  ) {
    throw new FreeBsdPkgOwnershipError("pkg-ownership-unavailable", "database", {
      operation: "pkg query",
      ...(result.termination === "timeout"
        ? { budgetMs: timeoutMs }
        : { code: extractErrorCode(result.error) }),
    });
  }
  const output = result.stdout.toString("utf8");
  if (output !== "" && !output.endsWith("\n")) {
    throw new FreeBsdPkgOwnershipError("pkg-ownership-unavailable", "database", {
      operation: "pkg query",
    });
  }
  const files = output === "" ? [] : output.slice(0, -1).split("\n");
  if (
    files.length > 250_000 ||
    files.some((file) => !path.isAbsolute(file) || containsAsciiControlCharacter(file))
  ) {
    throw new FreeBsdPkgOwnershipError("pkg-ownership-unavailable", "database", {
      operation: "pkg query",
    });
  }
  return files;
}

/** One planning snapshot; create a fresh inspection before installation effects. */
export function createFreeBsdPkgOwnershipInspection(
  timeoutMs = PKG_INSPECTION_TIMEOUT_MS,
): FreeBsdPkgOwnershipInspection {
  let files: Promise<string[]> | undefined;
  const directories = new Map<string, Promise<string>>();
  const assertions = new Map<string, Promise<void>>();
  const budget = Number.isFinite(timeoutMs)
    ? Math.min(PKG_INSPECTION_TIMEOUT_MS, Math.max(1, timeoutMs))
    : PKG_INSPECTION_TIMEOUT_MS;
  // Query and all path lookups share one short budget, independent of the
  // package manager's potentially much longer installation timeout.
  let deadline: number | undefined;
  let pathReads = 0;
  const read = async <T>(
    source: "database" | "paths",
    label: InspectionOperation,
    operation: () => Promise<T>,
  ) => {
    try {
      const value = await awaitWithinDeadline(operation, deadline);
      if (value !== ABSOLUTE_DEADLINE_EXPIRED) {
        return value;
      }
    } catch (error) {
      if (error instanceof FreeBsdPkgOwnershipError) {
        throw error;
      }
      throw new FreeBsdPkgOwnershipError("pkg-ownership-unavailable", source, {
        operation: label,
        code: extractErrorCode(error),
      });
    }
    throw new FreeBsdPkgOwnershipError("pkg-ownership-unavailable", source, {
      operation: label,
      budgetMs: budget,
    });
  };
  const readPath = <T>(label: "lstat" | "realpath", operation: () => Promise<T>) =>
    read("paths", label, () => {
      if (++pathReads > 50_000) {
        throw new FreeBsdPkgOwnershipError("pkg-ownership-unavailable", "paths");
      }
      return operation();
    });
  // Resolve parents, not registered file symlinks: pkg owns the directory
  // entry replaced by an update, not a symlink's unrelated referent.
  const canonicalDirectory = (directory: string): Promise<string> =>
    read("paths", "directory resolution", () => {
      let canonical = directories.get(directory);
      if (!canonical) {
        canonical = (async () => {
          // fs-safe's ancestor lookup is synchronous. Bound each asynchronous
          // lookup here so a late ENOENT cannot start work after the deadline.
          let ancestor = directory;
          while (
            !(await readPath("lstat", () =>
              fs.lstat(ancestor).then(
                () => true,
                (error: unknown) => {
                  if (hasNodeErrorCode(error, "ENOENT")) {
                    return false;
                  }
                  throw error;
                },
              ),
            ))
          ) {
            const parent = path.dirname(ancestor);
            if (parent === ancestor) {
              throw new FreeBsdPkgOwnershipError("pkg-ownership-unavailable", "paths");
            }
            ancestor = parent;
          }
          return path.resolve(
            await readPath("realpath", () => fs.realpath(ancestor)),
            path.relative(ancestor, directory),
          );
        })();
        directories.set(directory, canonical);
      }
      return canonical;
    });
  const assertUnowned = async (lexicalRoot: string, entryOnly: boolean) => {
    // Start cached work inside the admitted callback so synchronous budget
    // consumption cannot leave a started promise outside the deadline race.
    const inventory = await read("database", "pkg query", () => (files ??= readPkgFiles(budget)));
    const matches = (candidate: string, file: string) =>
      entryOnly ? candidate === file : isPathInside(candidate, file);
    // A recorded lexical owner is authoritative even when another package's
    // directories are inaccessible. Finish this pass before resolving aliases.
    if (inventory.some((file) => matches(lexicalRoot, file))) {
      throw new FreeBsdPkgOwnershipError("pkg-owned-install");
    }
    const rootEntry = path.join(
      await canonicalDirectory(path.dirname(lexicalRoot)),
      path.basename(lexicalRoot),
    );
    const canonicalRoot = entryOnly ? rootEntry : await canonicalDirectory(lexicalRoot);
    for (const file of inventory) {
      const canonicalFile = path.join(
        await canonicalDirectory(path.dirname(file)),
        path.basename(file),
      );
      // An aliased root symlink is itself an owned entry even when its
      // referent is outside the package prefix.
      if (canonicalFile === rootEntry || matches(canonicalRoot, canonicalFile)) {
        throw new FreeBsdPkgOwnershipError("pkg-owned-install");
      }
    }
  };
  const inspect = (root: string | null | undefined, entryOnly = false) => {
    if (process.platform !== "freebsd" || !root) {
      return Promise.resolve();
    }
    const resolvedRoot = path.resolve(root);
    const key = `${entryOnly}:${resolvedRoot}`;
    const cached = assertions.get(key);
    if (cached) {
      return cached;
    }
    deadline ??= Date.now() + budget;
    if (Date.now() >= deadline) {
      return Promise.reject(
        new FreeBsdPkgOwnershipError("pkg-ownership-unavailable", "paths", {
          operation: "path inspection",
          budgetMs: budget,
        }),
      );
    }
    const assertion = assertUnowned(resolvedRoot, entryOnly);
    assertions.set(key, assertion);
    return assertion;
  };
  return {
    assertUnowned: (root) => inspect(root),
    assertEntryUnowned: (file) => inspect(file, true),
  };
}
