import type { CreateManagedWorktreeParams, ManagedWorktreeRecord } from "./types.js";

export function assertOwnerWorktreeReuse(
  record: ManagedWorktreeRecord,
  params: Pick<CreateManagedWorktreeParams, "ownerKind" | "ownerId" | "baseRef">,
  repoRoot: string,
): void {
  if (record.repoRoot !== repoRoot) {
    throw new Error(
      `worktree owner ${params.ownerKind ?? "manual"} ${params.ownerId} is already bound to another repository`,
    );
  }
  if (record.ownerKind === "workboard" && params.baseRef && params.baseRef !== record.baseRef) {
    throw new Error(
      `worktree ${record.name} already uses base ref ${record.baseRef}; requested ${params.baseRef}. Existing checkout preserved; use a new owner and name for a different base.`,
    );
  }
}

export function worktreeOwnerMatches(
  record: ManagedWorktreeRecord,
  params: Pick<CreateManagedWorktreeParams, "ownerKind" | "ownerId">,
): boolean {
  return (
    record.ownerKind === (params.ownerKind ?? "manual") &&
    (record.ownerId ?? undefined) === (params.ownerId ?? undefined)
  );
}
