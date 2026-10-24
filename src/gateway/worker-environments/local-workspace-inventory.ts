import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { isStringArray } from "@openclaw/normalization-core/record-coerce";
import { splitNullBuffer } from "../../agents/worktrees/git-path-inventory.js";
import { requireGitBuffer } from "../../agents/worktrees/git.js";
import { manifestNodes } from "./workspace-manifest-comparison.js";
import {
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import { workspacePathAncestors } from "./workspace-path-ancestors.js";

export function decodeLocalWorkspaceGitPaths(listed: Buffer): string[] {
  if (!isUtf8(listed)) {
    throw new Error(
      "Local sandbox source paths must be UTF-8; rename the invalid Git path before retrying",
    );
  }
  return listed.toString("utf8").split("\0").filter(Boolean);
}

export function parseLocalWorkspaceSourcePaths(value: string): string[] {
  const paths: unknown = JSON.parse(value);
  if (!isStringArray(paths)) {
    throw new Error("Invalid local workspace source admission");
  }
  return paths;
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
  return JSON.stringify([...new Set(decodeLocalWorkspaceGitPaths(listed))]);
}

/** Ignore changes are source edits, not authority to enroll canonical-only bytes. */
export async function selectLocalWorkspaceCanonicalPaths(params: {
  root: string;
  admittedPaths: string;
  // Reuse authoritative host inputs read earlier in this operation.
  preparedPaths?: ReadonlySet<string>;
  baseline?: WorkerWorkspaceManifest;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<Set<string>> {
  params.signal?.throwIfAborted();
  params.assertCurrent();
  let paths: Set<string>;
  if (params.preparedPaths) {
    paths = new Set(params.preparedPaths);
  } else {
    const listed = await requireGitBuffer(params.root, ["ls-files", "--cached", "-z"], {
      signal: params.signal,
      beforeRun: params.assertCurrent,
    });
    params.assertCurrent();
    // Only the host owns this index; the guest has independent Git metadata. A
    // host can deliberately admit a new path with git add, even if it is ignored.
    const admitted = parseLocalWorkspaceSourcePaths(params.admittedPaths);
    paths = new Set<string>([...admitted, ...decodeLocalWorkspaceGitPaths(listed)]);
  }
  if (params.baseline) {
    for (const entryPath of manifestNodes(params.baseline).keys()) {
      paths.add(entryPath);
    }
  }
  // The inventory contract requires explicit ancestors, including directories
  // omitted by Git and empty directories already accepted from the guest.
  for (const entryPath of paths) {
    for (const parent of workspacePathAncestors(entryPath)) {
      paths.add(parent);
    }
  }
  return paths;
}

/** Git archives omit accepted ignored leaves and empty directories; retain that overlay separately. */
export async function captureLocalWorkspaceArchiveBaseline(params: {
  root: string;
  snapshotCommit: string;
  manifest: WorkerWorkspaceManifest;
  signal: AbortSignal;
  assertCurrent: () => void;
}) {
  const { signal, assertCurrent } = params;
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(params.snapshotCommit)) {
    throw new Error("Invalid archive snapshot commit");
  }
  const listed = await requireGitBuffer(
    params.root,
    ["ls-tree", "-r", "-z", "--name-only", params.snapshotCommit],
    {
      signal,
      beforeRun: assertCurrent,
      maxOutputBytes: 64 * 1024 * 1024,
    },
  );
  assertCurrent();
  const paths = new Set(splitNullBuffer(listed).map((entry) => entry.toString("hex")));
  const entries = params.manifest.entries.filter((entry) =>
    paths.has(Buffer.from(entry.path).toString("hex")),
  );
  const directories = new Set<string>();
  for (const entry of entries) {
    for (const parent of workspacePathAncestors(entry.path)) {
      directories.add(parent);
    }
  }
  const base = serializeWorkerWorkspaceManifest({
    ...params.manifest,
    entries,
    directories: [...directories].toSorted(),
  });
  const baseRef = "sha256:" + createHash("sha256").update(base).digest("hex");
  return { rawManifest: base, manifestRef: baseRef };
}
