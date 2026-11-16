import os from "node:os";
import { gitReadOnlyEnvironment } from "../infra/git-exec.js";
import { appendGitConfig, gitMaintenanceEnvironment } from "../infra/git-maintenance-env.js";
import { resolveCommandEnv } from "../process/exec-spawn.js";

export function publicationCommandEnv(argv: string[], env: NodeJS.ProcessEnv = {}) {
  return {
    ...(argv[0] === "git" ? gitReadOnlyEnvironment(argv.slice(1), env) : env),
    GIT_NO_REPLACE_OBJECTS: "1",
    // Explicit hook-disabling -c flags remain stronger than this environment.
    ...appendGitConfig(gitMaintenanceEnvironment(), [["core.hooksPath", os.devNull]]),
  };
}

/** Capture the complete child environment after the read's first transport admission. */
export function createGitHubPublicationReadEnvironment(env: NodeJS.ProcessEnv) {
  let prepared: NodeJS.ProcessEnv | undefined;
  return () =>
    (prepared ??= resolveCommandEnv({ argv: ["gh"], env: publicationCommandEnv(["gh"], env) }));
}
