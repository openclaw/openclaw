import fs from "node:fs/promises";
import path from "node:path";
import { gitReleaseForwardingEntry, GIT_RELEASE_LAUNCHER } from "../../infra/git-release-paths.js";
import { restoreInterruptedNpmPackageRootLink } from "../../infra/package-update-npm-root.js";
import { resolveGlobalInstallTarget } from "../../infra/update-global.js";
import { runCommandWithTimeout } from "../../process/exec.js";

/** The checkout a release is a worktree of. */
export async function resolveGitReleaseCheckout(
  release: string,
  fallback: string,
  timeoutMs: number,
) {
  const res = await runCommandWithTimeout(
    ["git", "-C", release, "rev-parse", "--path-format=absolute", "--git-common-dir"],
    { timeoutMs },
  ).catch(() => null);
  const commonDir = res?.code === 0 ? res.stdout.trim() : "";
  return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : fallback;
}

/** Global packages (npm, pnpm or Bun) linked to this checkout, by a user or an earlier switch. */
export async function findGlobalPackagesLinkedTo(checkout: string, timeoutMs: number) {
  // A checkout is linked globally with `npm link`, `pnpm add -g openclaw@link:` or `bun link`;
  // whichever bin directory is first on PATH must run the release, so every link moves.
  const linked = new Set<string>();
  for (const manager of ["npm", "pnpm", "bun"] as const) {
    const target = await resolveGlobalInstallTarget({
      manager,
      runCommand: runCommandWithTimeout,
      timeoutMs,
    }).catch(() => null);
    const packageRoot = target?.packageRoot;
    if (!packageRoot) {
      continue;
    }
    // A swap killed between its two renames left the link under its backup name.
    if (!(await fs.lstat(packageRoot).catch(() => null))) {
      await restoreInterruptedNpmPackageRootLink(
        path.dirname(packageRoot),
        packageRoot,
        checkout,
        false,
      ).catch(() => undefined);
    }
    if (await isLinkTo(packageRoot, checkout)) {
      linked.add(packageRoot);
    }
  }
  return [...linked];
}

async function isLinkTo(link: string, dir: string): Promise<boolean> {
  if (!(await fs.lstat(link).catch(() => null))?.isSymbolicLink()) {
    return false;
  }
  const [linked, real] = await Promise.all(
    [link, dir].map((entry) => fs.realpath(entry).catch(() => null)),
  );
  return linked !== null && linked === real;
}

/**
 * Point the global npm package's `openclaw.mjs`, which its bin shims run, at the release launcher,
 * so `openclaw` on PATH runs the release the launcher selects (a `--no-restart` target is pending
 * until the next Gateway start) and a foreground Gateway start counts toward the trial. The rest
 * of the package stays: this updater and a running Gateway still load from it, and an old service
 * definition may still name its `dist/index.js`. Its disk space stays used until a switch back to
 * npm replaces it (destination ownership recognizes this exact entry).
 *
 * An updater before #200578 switched to Git by linking the global package to the checkout, which
 * it then rebuilt in place. Releases never rebuild the checkout, so that link is replaced by a
 * directory holding only the entries (writing through it would edit the checkout). Its
 * `dist/index.js` also starts the launcher, for a service definition that names the package path
 * and is not refreshed (`--no-restart`). Other links (a pnpm store path) are written through, as
 * before. The link moves to the backup name npm package updates use, so a process killed before
 * the stage takes its place leaves it where the next Git update puts it back and retries.
 */
export async function exposeGlobalPackageThroughRelease(
  packageRoot: string,
  slot: string,
  checkout: string,
): Promise<string | undefined> {
  const launcher = path.join(path.dirname(slot), GIT_RELEASE_LAUNCHER);
  const contents = gitReleaseForwardingEntry(launcher);
  const linked = await isLinkTo(packageRoot, checkout);
  const stage = `${packageRoot}.release-${process.pid}`;
  const backup = path.join(
    path.dirname(packageRoot),
    `.openclaw.package-backup-${process.pid}-${Date.now()}`,
  );
  let moved = false;
  try {
    if (linked) {
      await fs.mkdir(path.join(stage, "dist"), { recursive: true });
      await fs.writeFile(
        path.join(stage, "package.json"),
        `${JSON.stringify({ name: "openclaw", private: true, type: "module", bin: { openclaw: "openclaw.mjs" } })}\n`,
      );
      await fs.writeFile(path.join(stage, "dist", "index.js"), contents);
      await fs.writeFile(path.join(stage, "openclaw.mjs"), contents, { mode: 0o755 });
      await fs.rename(packageRoot, backup);
      moved = true;
      await fs.rename(stage, packageRoot);
      moved = false;
      await fs.unlink(backup).catch(() => {});
    } else {
      await fs.writeFile(stage, contents, { mode: 0o755 });
      await fs.rename(stage, path.join(packageRoot, "openclaw.mjs"));
    }
    return undefined;
  } catch (error) {
    if (moved) {
      await fs.rename(backup, packageRoot).catch(() => {});
    }
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    return `${packageRoot} could not start ${launcher} (${String(error)}); \`openclaw\` on PATH still starts the previous build.`;
  }
}
