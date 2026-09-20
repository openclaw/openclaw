/** Reserved runtime projection, not project-owned .openclaw content. */
export const MATERIALIZED_SANDBOX_SKILLS_WORKSPACE_PARTS = [".openclaw", "sandbox-skills"] as const;
export const MATERIALIZED_SANDBOX_SKILLS_WORKSPACE =
  MATERIALIZED_SANDBOX_SKILLS_WORKSPACE_PARTS.join("/");

export function isManagedSandboxSkillsPath(relativePath: string): boolean {
  return (
    relativePath === MATERIALIZED_SANDBOX_SKILLS_WORKSPACE ||
    relativePath.startsWith(`${MATERIALIZED_SANDBOX_SKILLS_WORKSPACE}/`)
  );
}
