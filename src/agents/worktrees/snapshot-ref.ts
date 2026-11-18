/** Clean recovery refs pin HEAD directly; older and dirty captures wrap it in a commit. */
export function worktreeSnapshotBase(ref: string, commit: string): string {
  return ref.startsWith("refs/openclaw/snapshots/clean-v1/") ? commit : `${commit}^`;
}
