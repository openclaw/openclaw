export const MANAGED_GITLAB_PROFILE_ID_PATTERN = /^glp_[a-f0-9]{32}$/u;

export function isManagedGitLabProfileId(value: string): boolean {
  return MANAGED_GITLAB_PROFILE_ID_PATTERN.test(value);
}
