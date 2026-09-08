import path from "node:path";

/**
 * Module-resolution failures that a completed install swap can cause in the
 * still-running updater process.
 */
const REPLACED_MODULE_ERROR_CODES = new Set(["ENOENT", "ERR_MODULE_NOT_FOUND"]);

/**
 * Only executable modules vanish this way. A missing data file inside the
 * install root means the installation itself is broken.
 */
const MODULE_FILE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".node"]);

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** Paths Node reports either structurally or quoted inside the message. */
function collectCandidatePaths(err: NodeJS.ErrnoException): string[] {
  const candidates: string[] = [];
  if (typeof err.path === "string" && err.path.length > 0) {
    candidates.push(err.path);
  }
  const message = typeof err.message === "string" ? err.message : "";
  for (const match of message.matchAll(/'([^']+)'|"([^"]+)"/gu)) {
    const value = match[1] ?? match[2];
    if (value) {
      candidates.push(value);
    }
  }
  return candidates;
}

/**
 * Reports whether an error is this process failing to load its own code because
 * the install swap replaced the tree underneath it.
 *
 * A package update stages the new version, swaps it over the live install root,
 * and only then restarts and verifies the gateway. The updater is still running
 * the *previous* build, and a bundled dist splits into content-hashed chunks, so
 * any `import()` that had not already been evaluated resolves to a chunk name
 * that exists only in the replaced tree -- `dist/shared-DFJEouXv.js` and the
 * like. Node raises ENOENT (the ESM loader reading the source) or
 * ERR_MODULE_NOT_FOUND.
 *
 * This says nothing about the health of the newly installed version: it is an
 * artifact of the updater's own process, so it must not be read as evidence
 * that restarting the service is unsafe.
 */
export function isReplacedInstallModuleError(
  err: unknown,
  installRoot: string | undefined,
): boolean {
  if (!installRoot?.trim()) {
    // Without a root there is nothing to attribute the failure to, so the safe
    // reading is that this is a genuine failure.
    return false;
  }
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (!code || !REPLACED_MODULE_ERROR_CODES.has(code)) {
    return false;
  }
  const root = path.resolve(installRoot);
  return collectCandidatePaths(err as NodeJS.ErrnoException).some((candidate) => {
    const resolved = path.resolve(candidate);
    return (
      MODULE_FILE_EXTENSIONS.has(path.extname(resolved).toLowerCase()) &&
      isInsideRoot(root, resolved)
    );
  });
}
