export type WorktreeTemplateRecord = {
  cacheKey: string;
  id: string;
  repoRoot: string;
  commonDir: string;
  worktreeRoot: string;
  path: string;
  backend: string;
  sourceCommit: string;
  contentKey: string;
  status: "preparing" | "ready";
  createdAt: number;
  lastUsedAt: number;
};

export const retainedWorktreeTemplateKey = (cacheKey: string, contentKey: string) =>
  `retained:${cacheKey}:${contentKey}`;

/** Retained commits share the publication owner's mutation lease. */
export function worktreeTemplateMutationKey(cacheKey: string): string {
  return cacheKey.startsWith("retained:")
    ? cacheKey.slice("retained:".length, cacheKey.lastIndexOf(":"))
    : cacheKey;
}

export type WorktreeWarmPoolRequest = {
  template: WorktreeTemplateRecord;
  sourceOnly: boolean;
  cloneBytes?: number;
};
