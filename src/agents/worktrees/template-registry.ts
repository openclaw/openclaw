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

export type WorktreeWarmPoolRequest = {
  template: WorktreeTemplateRecord;
  sourceOnly: boolean;
  cloneBytes?: number;
};
