import fs from "node:fs";
import path from "node:path";

export type DependencyLinkOutcome = "created" | "reused" | "replaced";

/**
 * Ensures `link` is a junction pointing at `target`.
 *
 * Windows capture workspaces build the same dependency graph from several
 * package roots. Two roots can therefore race on the same link path, and a
 * link left by an earlier (disposed) capture can dangle. `fs.existsSync`
 * follows links, so a dangling junction looks "absent" and the subsequent
 * `symlinkSync` fails with EEXIST — which surfaces as a Doctor contract load
 * failure and refuses every plugin migration that depends on it.
 *
 * Detect the entry with `lstatSync` (does not follow), retire dangling links,
 * and treat EEXIST as success when the path now resolves to `target`.
 */
export function ensureDependencyLink(link: string, target: string): DependencyLinkOutcome {
  const state = linkState(link);
  if (state === "valid") {
    return "reused";
  }
  if (state === "dangling") {
    fs.rmSync(link, { force: true, recursive: false });
  }
  fs.mkdirSync(path.dirname(link), { recursive: true, mode: 0o700 });
  try {
    fs.symlinkSync(path.relative(path.dirname(link), target), link, "junction");
    return state === "dangling" ? "replaced" : "created";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" && linkState(link) === "valid") {
      return "reused";
    }
    throw error;
  }
}

type LinkState = "absent" | "valid" | "dangling";

function linkState(link: string): LinkState {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "absent";
    }
    throw error;
  }
  // Real files/directories win: never replace an actually installed dependency.
  if (!stat.isSymbolicLink()) {
    return "valid";
  }
  try {
    fs.statSync(link);
    return "valid";
  } catch {
    return "dangling";
  }
}
