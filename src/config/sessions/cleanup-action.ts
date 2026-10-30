export type SessionCleanupAction =
  | "keep"
  | "archive-dashboard"
  | "archive-cap"
  | "archive-age"
  | "prune-missing"
  | "prune-model-run"
  | "prune-stale"
  | "cap-overflow"
  | "retire-dm-scope";

export function resolveSessionCleanupAction(params: {
  key: string;
  missingKeys: Set<string>;
  modelRunPrunedKeys: Set<string>;
  archivedKeys?: Set<string>;
  capArchivedKeys?: Set<string>;
  ageArchivedKeys?: Set<string>;
  staleKeys: Set<string>;
  cappedKeys: Set<string>;
  dmScopeRetiredKeys: Set<string>;
}): SessionCleanupAction {
  for (const [keys, action] of [
    [params.dmScopeRetiredKeys, "retire-dm-scope"],
    [params.missingKeys, "prune-missing"],
    [params.modelRunPrunedKeys, "prune-model-run"],
    [params.archivedKeys, "archive-dashboard"],
    [params.capArchivedKeys, "archive-cap"],
    [params.ageArchivedKeys, "archive-age"],
    [params.staleKeys, "prune-stale"],
    [params.cappedKeys, "cap-overflow"],
  ] as const) {
    if (keys?.has(params.key)) {
      return action;
    }
  }
  return "keep";
}
