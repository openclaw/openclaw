/** Names reserved for profile-owned personal GitLab state. */
export function isHiddenGitLabStoreName(name: string): boolean {
  return (
    /^gitlab-connection-[a-f0-9]{64}$/u.test(name) ||
    /^gitlab-(setup|oauth)-[a-f0-9]{32}$/u.test(name)
  );
}
