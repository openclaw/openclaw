// Restored readers join ledger and sentinel diagnostics using these released keys.
const RELEASED_STEP_KEYS = new Map<string, string>([
  ["package-install", "global update"],
  ["package-install-omit-optional", "global update (omit optional)"],
  ["git-fetch", "git fetch"],
  ["git-fetch-tags", "git fetch tags"],
  ["git-fetch-target-tag", "git fetch target tag"],
  ["git-target-inspection-fetch", "git target inspection fetch"],
  ["git-import-admitted-target", "git import admitted target"],
]);

export function updateRunStepKey(step: string): string {
  return RELEASED_STEP_KEYS.get(step) ?? step;
}
