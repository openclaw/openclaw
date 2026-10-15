import { isUtf8 } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode } from "@openclaw/normalization-core/error-coercion";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import { normalizeSupportDiagnosticErrorCode } from "../logging/diagnostic-support-redaction.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runCommandBuffered } from "../process/exec.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../utils/absolute-deadline.js";
import { isPathInside } from "./fs-safe.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { UpdatePreMutationError } from "./update-pre-mutation-error.js";

export const PKG_INSPECTION_TIMEOUT_MS = 30_000;

const PACKAGE_OWNERS = [
  {
    platform: "freebsd",
    manager: "pkg",
    label: "FreeBSD pkg",
    command: ["/usr/sbin/pkg", "-N", "query", "-a", "%Fp"],
    env: { ALIAS: "query=query", PKG_ENABLE_PLUGINS: "no" },
    guidance: "Update it through pkg or the Ports deployment that owns it",
  },
  {
    platform: "linux",
    manager: "pacman",
    label: "pacman",
    command: ["pacman", "-Qql"],
    env: undefined,
    guidance: "Update with `pacman -Syu` or your AUR helper",
  },
] as const;

function packageOwner() {
  return PACKAGE_OWNERS.find((owner) => owner.platform === process.platform);
}

type InspectionOperation = "pkg query" | "pacman query" | "lstat" | "realpath" | "path inspection";
type InspectionDiagnostic = { operation: InspectionOperation } & (
  | { code?: string }
  | { budgetMs: number }
);

export class SystemPackageOwnershipError extends UpdatePreMutationError {
  readonly owned: boolean;
  constructor(
    kind: "owned-install" | "ownership-unavailable",
    source: "database" | "paths" = "database",
    diagnostic?: InspectionDiagnostic,
  ) {
    const owner = packageOwner() ?? PACKAGE_OWNERS[0];
    const code =
      diagnostic && "code" in diagnostic
        ? normalizeSupportDiagnosticErrorCode(diagnostic.code)
        : undefined;
    // Facts truncate messages to 200 characters; keep the safe owning failure first.
    const prefix = !diagnostic
      ? ""
      : "budgetMs" in diagnostic
        ? `${owner.label} inspection exhausted its shared ${diagnostic.budgetMs} ms budget during ${diagnostic.operation}. `
        : `${owner.label} inspection failed during ${diagnostic.operation}${code ? ` (${code})` : ""}. `;
    super(
      `${owner.manager}-${kind}`,
      prefix +
        (kind === "owned-install"
          ? `This installation contains files installed by ${owner.label}. ${owner.guidance}; openclaw update will not replace package-owned files.`
          : source === "paths"
            ? `${owner.label} paths could not be inspected completely. Check access to the registered package directories and installation paths, and resolve any inspection timeout before retrying.`
            : `${owner.label} ownership could not be verified. Restore access to the active ${owner.manager} database and configuration, then retry.`),
    );
    this.owned = kind === "owned-install";
  }
}

export type SystemPackageOwnershipInspection = ReturnType<
  typeof createSystemPackageOwnershipInspection
>;

async function readPackageFiles(
  owner: NonNullable<ReturnType<typeof packageOwner>>,
  timeoutMs: number,
  runCommand: typeof runCommandBuffered,
): Promise<string[]> {
  // -N prevents the base-system pkg launcher from bootstrapping. Pin the builtin
  // query: pkg expands aliases once, and plugin initialization precedes dispatch.
  const result = await runCommand([...owner.command], {
    timeoutMs,
    env: owner.env,
    maxOutputBytes: { stdout: 16 * 1024 * 1024, stderr: 64 * 1024 },
  });
  // pkg may emit a config error with exit 0; only complete, silent output is authoritative.
  const output = result.stdout.toString("utf8");
  const files = output === "" ? [] : output.slice(0, -1).split("\n");
  if (
    result.termination !== "exit" ||
    result.code !== 0 ||
    result.stderr.length !== 0 ||
    !isUtf8(result.stdout) ||
    (output !== "" && !output.endsWith("\n")) ||
    files.length > 250_000 ||
    files.some((file) => !path.isAbsolute(file) || containsAsciiControlCharacter(file))
  ) {
    throw new SystemPackageOwnershipError("ownership-unavailable", "database", {
      operation: `${owner.manager} query`,
      ...(result.termination === "timeout"
        ? { budgetMs: timeoutMs }
        : { code: extractErrorCode(result.error) }),
    });
  }
  return files;
}

/** One planning snapshot; create a fresh inspection before installation effects. */
const log = createSubsystemLogger("update");

export function createSystemPackageOwnershipInspection(
  timeoutMs = PKG_INSPECTION_TIMEOUT_MS,
  options: {
    runCommand?: typeof runCommandBuffered;
    onWarning?: (message: string) => void;
  } = {},
) {
  const owner = packageOwner();
  let files: Promise<string[]> | undefined;
  let unavailable = false;
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
      const value = await awaitWithinDeadline(() => {
        if (source === "paths" && ++pathReads > 50_000) {
          throw new SystemPackageOwnershipError("ownership-unavailable", "paths");
        }
        return operation();
      }, deadline);
      if (value !== ABSOLUTE_DEADLINE_EXPIRED) {
        return value;
      }
    } catch (error) {
      if (error instanceof SystemPackageOwnershipError) {
        throw error;
      }
      throw new SystemPackageOwnershipError("ownership-unavailable", source, {
        operation: label,
        code: extractErrorCode(error),
      });
    }
    throw new SystemPackageOwnershipError("ownership-unavailable", source, {
      operation: label,
      budgetMs: budget,
    });
  };
  // Cache ancestor resolution too; registered entries refer to the entry itself,
  // so resolve its parent without following a final file symlink.
  const canonicalDirectory = (directory: string): Promise<string> =>
    getOrCreatePromise(directories, directory, async () => {
      const stat = await read("paths", "lstat", () =>
        fs.lstat(directory).catch((error: unknown) => {
          if (hasNodeErrorCode(error, "ENOENT")) {
            return null;
          }
          throw error;
        }),
      );
      if (stat) {
        return read("paths", "realpath", () => fs.realpath(directory));
      }
      const parent = path.dirname(directory);
      if (parent === directory) {
        throw new SystemPackageOwnershipError("ownership-unavailable", "paths");
      }
      return path.join(await canonicalDirectory(parent), path.basename(directory));
    });
  const canonicalEntry = async (file: string) =>
    path.join(await canonicalDirectory(path.dirname(file)), path.basename(file));
  const assertUnowned = async (lexicalRoot: string, entryOnly: boolean) => {
    if (!owner) {
      return;
    }
    // Start cached work inside the admitted callback so synchronous budget
    // consumption cannot leave a started promise outside the deadline race.
    const inventory = await read(
      "database",
      `${owner.manager} query`,
      () => (files ??= readPackageFiles(owner, budget, options.runCommand ?? runCommandBuffered)),
    );
    const matches = (candidate: string, file: string) =>
      entryOnly ? candidate === file : isPathInside(candidate, file);
    // A recorded lexical owner is authoritative even when another package's
    // directories are inaccessible. Finish this pass before resolving aliases.
    if (inventory.some((file) => matches(lexicalRoot, file))) {
      throw new SystemPackageOwnershipError("owned-install");
    }
    const rootEntry = await canonicalEntry(lexicalRoot);
    const canonicalRoot = entryOnly ? rootEntry : await canonicalDirectory(lexicalRoot);
    for (const file of inventory) {
      const canonicalFile = await canonicalEntry(file);
      // An aliased root symlink is itself an owned entry even when its
      // referent is outside the package prefix.
      if (canonicalFile === rootEntry || matches(canonicalRoot, canonicalFile)) {
        throw new SystemPackageOwnershipError("owned-install");
      }
    }
  };
  const inspect = (root: string | null | undefined, entryOnly = false) => {
    if (!owner || !root || unavailable) {
      return Promise.resolve();
    }
    const resolvedRoot = path.resolve(root);
    return getOrCreatePromise(assertions, `${entryOnly}:${resolvedRoot}`, async () => {
      deadline ??= Date.now() + budget;
      if (Date.now() >= deadline) {
        throw new SystemPackageOwnershipError("ownership-unavailable", "paths", {
          operation: "path inspection",
          budgetMs: budget,
        });
      }
      return assertUnowned(resolvedRoot, entryOnly);
    }).catch((error: unknown) => {
      if (!(error instanceof SystemPackageOwnershipError) || error.owned) {
        throw error;
      }
      if (unavailable) {
        return;
      }
      unavailable = true;
      const warn = options.onWarning ?? ((message: string) => log.warn(message));
      warn(`${error.message} Continuing without verified system-package ownership.`);
    });
  };
  return {
    assertUnowned: (root: string | null | undefined) => inspect(root),
    assertEntryUnowned: (file: string) => inspect(file, true),
  };
}
