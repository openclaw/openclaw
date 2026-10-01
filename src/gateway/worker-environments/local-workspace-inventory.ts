import { isUtf8 } from "node:buffer";
import path from "node:path";
import { requireGitBuffer } from "../../agents/worktrees/git.js";
import { manifestNodes } from "./workspace-manifest-comparison.js";
import type { WorkerWorkspaceManifest } from "./workspace-manifest.js";

function decodeGitPaths(listed: Buffer): string[] {
  if (!isUtf8(listed)) {
    throw new Error(
      "Local sandbox source paths must be UTF-8; rename the invalid Git path before retrying",
    );
  }
  return listed.toString("utf8").split("\0").filter(Boolean);
}

/** Admit untracked source once, before any guest can change canonical ignore rules. */
export async function admitLocalWorkspaceSourcePaths(params: {
  root: string;
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<string> {
  const listed = await requireGitBuffer(
    params.root,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { signal: params.signal, beforeRun: params.assertCurrent },
  );
  params.assertCurrent();
  return JSON.stringify([...new Set(decodeGitPaths(listed))]);
}

/** Ignore changes are source edits, not authority to enroll canonical-only bytes. */
export async function selectLocalWorkspaceCanonicalPaths(params: {
  root: string;
  admittedPaths: string;
  baseline?: WorkerWorkspaceManifest;
  signal: AbortSignal;
  assertCurrent: () => void;
}): Promise<Set<string>> {
  const listed = await requireGitBuffer(params.root, ["ls-files", "--cached", "-z"], {
    signal: params.signal,
    beforeRun: params.assertCurrent,
  });
  params.assertCurrent();
  // Only the host owns this index; the guest has independent Git metadata. A
  // host can deliberately admit a new path with git add, even if it is ignored.
  const admitted: unknown = JSON.parse(params.admittedPaths);
  if (!Array.isArray(admitted) || !admitted.every((entry) => typeof entry === "string")) {
    throw new Error("Invalid local workspace source admission");
  }
  const paths = new Set<string>([...admitted, ...decodeGitPaths(listed)]);
  if (params.baseline) {
    for (const entryPath of manifestNodes(params.baseline).keys()) {
      paths.add(entryPath);
    }
  }
  // The inventory contract requires explicit ancestors, including directories
  // omitted by Git and empty directories already accepted from the guest.
  for (const entryPath of paths) {
    for (
      let parent = path.posix.dirname(entryPath);
      parent !== ".";
      parent = path.posix.dirname(parent)
    ) {
      paths.add(parent);
    }
  }
  return paths;
}
