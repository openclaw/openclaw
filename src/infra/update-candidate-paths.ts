import path from "node:path";
import { z } from "zod";
import { sha256Hex } from "./crypto-digest.js";
import { isPathInside, normalizeWindowsPathPreservingCase } from "./path-guards.js";

export const UPDATE_CANDIDATE_PLUGIN_PLAN_FILENAME = "plugin-copy-plan.json";

export const UpdateStateDatabaseOwnerSchema = z.discriminatedUnion("role", [
  z.object({ role: z.literal("global") }),
  z.object({ role: z.literal("agent"), agentId: z.string().min(1) }),
]);
export type UpdateStateDatabaseOwner = z.infer<typeof UpdateStateDatabaseOwnerSchema>;
/** Every raw spelling discovered for one database, grouped by projection identity. */
export const StateDatabaseDiscoverySchema = z.object({
  spellings: z.tuple([z.string()], z.string()),
  owners: z.array(UpdateStateDatabaseOwnerSchema).optional(),
});
export type StateDatabaseDiscovery = z.infer<typeof StateDatabaseDiscoverySchema>;

/**
 * One projection identity per locator, matching the raw canonical-spelling
 * eligibility of the rebase branch in resolveUpdateCandidateStatePath: only
 * canonically spelled in-root aliases take their case-preserving plain
 * spelling; external and noncanonical locators keep their raw spelling.
 * Discovery dedupes on this identity so the copy and the registry rebound
 * write always agree on one destination for every spelling of a database.
 */
export function resolveUpdateCandidateStateIdentity(sourceRoot: string, source: string): string {
  return process.platform === "win32" &&
    path.normalize(source) === source &&
    isPathInside(sourceRoot, source)
    ? normalizeWindowsPathPreservingCase(source)
    : source;
}

export function queueStateDatabaseSpelling(
  files: Map<string, StateDatabaseDiscovery>,
  stateRoot: string,
  file: string,
  owner?: UpdateStateDatabaseOwner,
): void {
  const identity = resolveUpdateCandidateStateIdentity(stateRoot, file);
  const discovery = files.get(identity);
  if (discovery) {
    if (!discovery.spellings.includes(file)) {
      discovery.spellings.push(file);
    }
    if (
      owner &&
      !discovery.owners?.some(
        (current) =>
          current.role === owner.role &&
          (current.role === "global" ||
            (owner.role === "agent" && current.agentId === owner.agentId)),
      )
    ) {
      (discovery.owners ??= []).push(owner);
    }
    return;
  }
  files.set(identity, { spellings: [file], ...(owner ? { owners: [owner] } : {}) });
}

// Keep path projection independent of snapshot orchestration: the snapshot owner
// dynamically loads plugin projection, so importing it back creates a worker build cycle.
/** Shared with config projection so custom agent directories use their copied database. */
export function resolveUpdateCandidateStatePath(
  sourceRoot: string,
  targetRoot: string,
  source: string,
): string {
  // The canonical-spelling guard reads the raw locator first: only a canonically
  // spelled in-root source is an alias eligible for rebasing.
  if (path.normalize(source) === source && isPathInside(sourceRoot, source)) {
    // Extended-length \\?\ spellings name the same files as their plain
    // counterparts, but path.relative cannot see across the namespace prefix: it
    // returns the absolute source unchanged, and joining that under the target
    // root would embed the prefix mid-path. Rebase in-root aliases through the
    // case-preserving plain spelling.
    const projectionRoot =
      process.platform === "win32" ? normalizeWindowsPathPreservingCase(sourceRoot) : sourceRoot;
    return path.join(
      targetRoot,
      path.relative(projectionRoot, resolveUpdateCandidateStateIdentity(sourceRoot, source)),
    );
  }
  // External and noncanonical locators keep their raw spelling as their
  // projection identity: registered link/../ locators can identify a different
  // inode from their normalized spelling; flattening them would overwrite
  // another copied database.
  return path.join(targetRoot, "candidate-external", sha256Hex(source));
}

/** Plugin locators cannot overwrite the separately snapshotted state databases. */
export function resolveUpdateCandidatePluginPath(
  sourceRoot: string,
  targetRoot: string,
  source: string,
): string {
  const managed = ["npm", "extensions"].some((directory) =>
    isPathInside(path.join(sourceRoot, directory), source),
  );
  return managed
    ? resolveUpdateCandidateStatePath(sourceRoot, targetRoot, source)
    : path.join(
        targetRoot,
        "candidate-plugins",
        sha256Hex(path.parse(source).root),
        path.relative(path.parse(source).root, source),
      );
}

/** Decode the ancestry retained by published drivers for external plugin copies. */
export function resolveUpdateCandidatePluginSourcePath(
  rehearsalRoot: string,
  copiedPath: string,
): string | undefined {
  const root = path.parse(copiedPath).root;
  const namespace = path.join(rehearsalRoot, "candidate-plugins", sha256Hex(root));
  if (
    !root ||
    path.normalize(copiedPath) !== copiedPath ||
    !isPathInside(namespace, copiedPath) ||
    namespace === copiedPath
  ) {
    return undefined;
  }
  // Other Windows volumes/UNC roots and managed state-relative copies lost their
  // original root in the published protocol. A matching path is not source authority.
  const source = path.join(root, path.relative(namespace, copiedPath));
  return resolveUpdateCandidatePluginPath(rehearsalRoot, rehearsalRoot, source) === copiedPath
    ? source
    : undefined;
}
