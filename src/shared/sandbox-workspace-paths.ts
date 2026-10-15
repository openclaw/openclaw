import { compileFunction } from "node:vm";

/** Reserved runtime projection, not project-owned .openclaw content. */
export const MATERIALIZED_SANDBOX_SKILLS_WORKSPACE_PARTS = [".openclaw", "sandbox-skills"] as const;
export const MATERIALIZED_SANDBOX_SKILLS_WORKSPACE =
  MATERIALIZED_SANDBOX_SKILLS_WORKSPACE_PARTS.join("/");

export const MANAGED_SANDBOX_SKILLS_PATH_JS = `
const MATERIALIZED_SANDBOX_SKILLS_WORKSPACE = ${JSON.stringify(MATERIALIZED_SANDBOX_SKILLS_WORKSPACE)};
function isManagedSandboxSkillsPath(relativePath) {
  return (
    relativePath === MATERIALIZED_SANDBOX_SKILLS_WORKSPACE ||
    relativePath.startsWith(MATERIALIZED_SANDBOX_SKILLS_WORKSPACE + "/")
  );
}`;

export const isManagedSandboxSkillsPath: (relativePath: string) => boolean = compileFunction(
  `${MANAGED_SANDBOX_SKILLS_PATH_JS}\nreturn isManagedSandboxSkillsPath;`,
)();
