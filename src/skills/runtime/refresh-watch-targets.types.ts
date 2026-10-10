export type WatchTarget = {
  path: string;
  roots: string[];
  authorityPath: string;
  depth: number;
  executionOnly?: true;
};

export type SkillsWatchTargetCacheEntry = {
  signature: string;
  targets: WatchTarget[];
};
