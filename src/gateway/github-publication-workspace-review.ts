import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SandboxContext } from "../agents/sandbox/types.js";
import { withWorktreeGitConfig } from "../agents/worktrees/checkout-git-config.js";
import type { LocalWorkspaceOwner } from "./worker-environments/local-workspace-types.js";
import { prepareWorkerWorkspaceGitPack } from "./worker-environments/workspace-git-base.js";
import { MAX_RECONCILIATION_PACK_BYTES } from "./worker-environments/workspace-manifest.js";

export async function readManagedSandboxGitState(params: {
  sandbox: SandboxContext;
  signal?: AbortSignal;
  assertCurrent: () => void;
}): Promise<{
  head: string;
  dirty: boolean;
  // Paths whose index differs from both HEAD and the working file, with the index entry in
  // ls-tree form ("<mode> blob <object>"); unmerged paths have none.
  partiallyStaged: { path: string; indexEntry?: string }[];
}> {
  const { sandbox, signal, assertCurrent } = params;
  assertCurrent();
  const observed = await sandbox.backend!.runShellCommand({
    script: READ_WORKSPACE_HEAD,
    args: [sandbox.containerWorkdir],
    signal,
  });
  assertCurrent();
  const output = observed.stdout.toString();
  const head = output.slice(0, output.indexOf("\n"));
  if (observed.code !== 0 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(head)) {
    throw new Error("The sandbox Git head could not be verified; existing work was preserved.");
  }
  const records = output.slice(head.length + 1).split("\0");
  const partiallyStaged: { path: string; indexEntry?: string }[] = [];
  let dirty = false;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (!record) {
      continue;
    }
    dirty = true;
    // Porcelain v2: "1 XY sub mH mI mW hH hI path", "2 … hI Xscore path" + NUL origPath, "u XY …".
    const fields = record.split(" ");
    const [kind, xy] = fields;
    if (kind === "2") {
      index += 1;
    }
    if (kind === "u") {
      partiallyStaged.push({ path: fields.slice(10).join(" ") });
    } else if ((kind === "1" || kind === "2") && xy?.[0] !== "." && xy?.[1] !== ".") {
      partiallyStaged.push({
        path: fields.slice(kind === "1" ? 8 : 9).join(" "),
        indexEntry: `${fields[4]} blob ${fields[7]}`,
      });
    }
  }
  return { head, dirty, partiallyStaged };
}

export async function prepareManagedWorkspaceReviewBase(params: {
  owner: LocalWorkspaceOwner;
  sandbox: SandboxContext;
  reviewCommit: string;
  previousBase?: string;
  signal?: AbortSignal;
  assertCurrent: () => void;
  reviewPreparationError: string;
}): Promise<{ mode: "local"; base: string }> {
  const {
    owner,
    sandbox,
    reviewCommit,
    previousBase,
    signal,
    assertCurrent,
    reviewPreparationError,
  } = params;
  // The guest can confirm only snapshots selected by the host. An arbitrary
  // guest donor could expose host-only data through Git's thin-pack deltas.
  const candidates = [
    ...new Set([reviewCommit, previousBase].filter((base) => base !== undefined)),
  ];
  assertCurrent();
  const available = await sandbox.backend!.runShellCommand({
    script: FIND_REVIEW_BASE,
    args: [sandbox.containerWorkdir, ...candidates],
    signal,
  });
  assertCurrent();
  if (available.code !== 0) {
    throw new Error(reviewPreparationError);
  }
  const advertised = available.stdout.toString().trim();
  const retainedCommit = candidates.find((candidate) => candidate === advertised);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-review-base-"));
  try {
    for (const retained of retainedCommit ? [retainedCommit, undefined] : [undefined]) {
      const temporaryRoot = path.join(temporary, retained ? "retained" : "full");
      await fs.mkdir(temporaryRoot);
      const pack = await withWorktreeGitConfig(
        owner.worktree.path,
        true,
        { beforeRun: assertCurrent },
        (git) =>
          git.withContentEnvironment((baseEnv) =>
            prepareWorkerWorkspaceGitPack({
              root: owner.worktree.path,
              baseCommit: reviewCommit,
              retainedCommit: retained,
              temporaryRoot,
              signal: signal ?? new AbortController().signal,
              baseEnv,
            }),
          ),
      );
      const size = (await fs.stat(pack)).size;
      if (size > MAX_RECONCILIATION_PACK_BYTES) {
        throw new Error(
          "The selected review base exceeds the sandbox transfer limit; saved integration is retained.",
        );
      }
      const input = await fs.readFile(pack);
      assertCurrent();
      const imported = await sandbox.backend!.runShellCommand({
        script: IMPORT_REVIEW_BASE,
        allowFailure: true,
        args: [sandbox.containerWorkdir, reviewCommit, retained ? "retained" : "full"],
        stdin: input,
        signal,
      });
      assertCurrent();
      if (imported.code === 0) {
        return { mode: "local", base: reviewCommit };
      }
      // Missing donor objects can invalidate a thin pack or leave omitted source
      // objects unavailable. Retry the authorized full snapshot before staging.
      if (!retained || imported.code !== 75) {
        throw new Error(reviewPreparationError);
      }
    }
    throw new Error(reviewPreparationError);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

const REVIEW_BASE_GIT = String.raw`set -eu
export GIT_NO_LAZY_FETCH=1 GIT_NO_REPLACE_OBJECTS=1 GIT_TERMINAL_PROMPT=0
git() { command git -c core.hooksPath=/dev/null -c core.fsmonitor=false "$@"; }
cd "$1"
test "$(git rev-parse --show-toplevel)" = "$(pwd -P)"
if git rev-parse --verify --quiet MERGE_HEAD >/dev/null; then
  exit 1
fi
`;

const READ_WORKSPACE_HEAD =
  REVIEW_BASE_GIT +
  String.raw`
git rev-parse --verify HEAD
git status --porcelain=v2 -z --untracked-files=all
`;

const FIND_REVIEW_BASE =
  REVIEW_BASE_GIT +
  String.raw`
shift
for candidate do
  if git cat-file -e "$candidate^{commit}" 2>/dev/null; then
    printf '%s\n' "$candidate"
    break
  fi
done
`;

const IMPORT_REVIEW_BASE =
  REVIEW_BASE_GIT +
  String.raw`
base="$2"
git index-pack --stdin --fix-thin >/dev/null || exit 75
if test "$3" = retained; then
  git rev-list --objects --no-object-names --missing=error "$base^{tree}" >/dev/null || exit 75
fi
missing_parent=false
for parent in $(git cat-file -p "$base" | sed -n '/^$/q; s/^parent //p'); do
  git cat-file -e "$parent^{commit}" 2>/dev/null || missing_parent=true
done
if "$missing_parent"; then
  shallow=$(git rev-parse --git-path shallow)
  if ! test -f "$shallow" || ! grep -Fxq "$base" "$shallow"; then
    (set -C; : > "$shallow.lock")
    trap 'rm -f "$shallow.lock"' EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    if test -f "$shallow"; then cat "$shallow" > "$shallow.lock"; fi
    printf '%s\n' "$base" >> "$shallow.lock"
    mv "$shallow.lock" "$shallow"
    trap - EXIT HUP INT TERM
  fi
fi
git update-ref refs/openclaw/review-base "$base"
filters=$(git config --name-only --get-regexp '^filter\..*\.(clean|smudge|process|required)$' || test "$?" = 1)
set -- -c core.hooksPath=/dev/null -c core.fsmonitor=false
for key in $filters; do set -- "$@" -c "$key="; done
git "$@" add -A -- .
`;
