import fs from "node:fs/promises";
import path from "node:path";
import { ignoreMissingPath } from "./errno.js";
import { gitReleaseSlot } from "./git-release-paths.js";
import { readPackageVersion } from "./package-json.js";
import { PACKAGE_RELEASES_DIR, packageReleaseGlobalRoot } from "./package-release-slot-path.js";
import { packageReleaseLinkTarget } from "./package-release-slot.js";
import {
  readBuiltGatewayBuildId,
  readBuiltRuntimeCommit,
  verifyGitUpdateRecovery,
} from "./update-git-runtime.js";

/** The build a Gateway serves, established from its own report, never from the release link. */
export type GitReleaseServingBuild = { root: string; commit: string; version: string };

export type GitReleaseBackout =
  | { kind: "keep" }
  | { kind: "replace"; previous: string; releaseRoot: string }
  | { kind: "none" };

/** Every release root under a Git release prefix: `releases/<id>/lib/node_modules/openclaw`. */
export async function listGitReleaseRoots(prefix: string): Promise<string[]> {
  const releasesDir = path.join(prefix, PACKAGE_RELEASES_DIR);
  const entries = (await fs.readdir(releasesDir).catch(ignoreMissingPath)) ?? [];
  return entries
    .filter((entry) => !entry.startsWith("."))
    .toSorted()
    .map((entry) => path.join(packageReleaseGlobalRoot(path.join(releasesDir, entry)), "openclaw"));
}

/** Locate the build a running Gateway reported among installed roots by its exact build ID. */
export async function locateServingGitBuild(
  reportedBuildId: string,
  roots: readonly string[],
): Promise<GitReleaseServingBuild | undefined> {
  for (const root of roots) {
    if ((await readBuiltGatewayBuildId(root)) !== reportedBuildId) {
      continue;
    }
    const [commit, version] = await Promise.all([
      readBuiltRuntimeCommit(root),
      readPackageVersion(root),
    ]);
    if (commit && version) {
      return { root, commit, version };
    }
  }
  return undefined;
}

/** A release the serving schema can boot: the serving commit and version, with verified artifacts. */
async function servesSameSchema(root: string, serving: GitReleaseServingBuild): Promise<boolean> {
  const [commit, version] = await Promise.all([
    readBuiltRuntimeCommit(root),
    readPackageVersion(root),
  ]);
  return (
    commit === serving.commit &&
    version === serving.version &&
    (await verifyGitUpdateRecovery({ root, sha: commit })).serviceRestartSafe
  );
}

/**
 * Which release a failed trial may switch back to. The fallback must boot on the state
 * the serving Gateway uses now, so it is a release of the serving commit, not whatever
 * the link named when the trial began (that can be a build that never served).
 */
export async function selectGitReleaseBackout(params: {
  prefix: string;
  /** The trial record's `previous` link text. */
  previous: string | undefined;
  serving: GitReleaseServingBuild;
}): Promise<GitReleaseBackout> {
  const slot = gitReleaseSlot(params.prefix);
  const current = params.previous ? path.resolve(path.dirname(slot), params.previous) : undefined;
  if (current && (await servesSameSchema(current, params.serving))) {
    return { kind: "keep" };
  }
  for (const releaseRoot of await listGitReleaseRoots(params.prefix)) {
    if (releaseRoot !== current && (await servesSameSchema(releaseRoot, params.serving))) {
      return {
        kind: "replace",
        previous: packageReleaseLinkTarget(slot, releaseRoot),
        releaseRoot,
      };
    }
  }
  return { kind: "none" };
}
