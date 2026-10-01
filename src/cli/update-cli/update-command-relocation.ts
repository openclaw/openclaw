import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { hasErrnoCode } from "../../infra/errors.js";
import { resolveGlobalInstallTarget } from "../../infra/update-global.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { resolveGitInstallDir, UpdatePreMutationError } from "./shared.js";
import type { GitInstallRelocation } from "./update-command-git.js";

// Resolve the invoking launcher before reusing the package-to-Git transaction.
// The original checkout is operator-owned; only its npm exposure may move.
export async function prepareDirtyGitRelocation(
  root: string,
  timeoutMs: number,
): Promise<GitInstallRelocation | undefined> {
  const { gitCleanCheckArgs } = await import("../../infra/update-runner-git-commands.js");
  const status = await runCommandWithTimeout(gitCleanCheckArgs(root), {
    timeoutMs,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (status.code !== 0 || !status.stdout.trim()) {
    return undefined;
  }
  const refuse = (message: string): never => {
    throw new UpdatePreMutationError(
      "dirty",
      `${message} The original checkout was preserved. Commit your changes and retry, or run openclaw triage.`,
    );
  };
  const launcher = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
  const originalRoot = await fs.realpath(root);
  if (
    process.platform === "win32" ||
    !launcher ||
    path.basename(launcher) !== "openclaw" ||
    path.basename(path.dirname(launcher)) !== "bin"
  ) {
    return refuse("The dirty Git installation does not have a recognized npm launcher.");
  }
  const packageRoot = path.resolve(path.dirname(launcher), "../lib/node_modules/openclaw");
  const { createPackageIntegrityReader } = await import("../../infra/package-update-integrity.js");
  const capture = async () => {
    const reader = createPackageIntegrityReader(timeoutMs);
    return [
      await reader.rootEntry(packageRoot, packageRoot, "link"),
      await reader.launcher(launcher),
    ];
  };
  const baseline = await capture();
  if ((await fs.realpath(launcher)) !== path.join(originalRoot, "openclaw.mjs")) {
    return refuse("The dirty Git installation does not have a recognized npm launcher.");
  }
  if (
    path.resolve(path.dirname(launcher), await fs.readlink(launcher)) !==
    path.join(packageRoot, "openclaw.mjs")
  ) {
    return refuse("The launcher does not follow the npm installation.");
  }
  if ((await fs.realpath(packageRoot)) !== originalRoot) {
    return refuse("The npm launcher belongs to another installation.");
  }
  const installTarget = await resolveGlobalInstallTarget({
    manager: "npm",
    pkgRoot: packageRoot,
    timeoutMs,
    runCommand: runCommandWithTimeout,
  });
  if (installTarget.manager !== "npm" || installTarget.packageRoot !== packageRoot) {
    return refuse("The npm installation owner could not be verified.");
  }
  const { resolvePathViaExistingAncestorSync } = await import("../../infra/boundary-path.js");
  const { isPathInside } = await import("../../infra/path-guards.js");
  let directory = resolveGitInstallDir();
  const entries = await fs.readdir(directory).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  });
  if (entries.length && !process.env.OPENCLAW_GIT_DIR?.trim()) {
    directory = `${directory}-${randomUUID()}`;
  } else if (entries.length) {
    return refuse("OPENCLAW_GIT_DIR must name an empty directory for this update.");
  }
  directory = resolvePathViaExistingAncestorSync(directory);
  if (
    [originalRoot, packageRoot].some(
      (owned) => isPathInside(owned, directory) || isPathInside(directory, owned),
    )
  ) {
    return refuse("The fresh checkout must be outside the existing installation.");
  }
  return {
    directory,
    installTarget,
    assertCurrent: async () => {
      if (
        !isDeepStrictEqual(baseline, await capture()) ||
        (await fs.realpath(packageRoot)) !== originalRoot
      ) {
        refuse("The npm launcher or installation changed while preparing the update.");
      }
    },
  };
}
