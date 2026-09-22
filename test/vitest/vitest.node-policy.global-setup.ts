import type { TestProject } from "vitest/node";
import { resolveVitestNodeArgs } from "../../scripts/lib/vitest-process-env.mts";

/** Vitest filters parent argv; fork processes need the shared policy explicitly. */
export default function setupVitestNodeArgs(root: TestProject): void {
  if (process.versions.bun) {
    return;
  }
  for (const project of root.vitest.projects) {
    if (!["forks", "vmForks", "openclaw-forks"].includes(project.config.pool)) {
      continue;
    }
    project.config.execArgv = [
      ...new Set([
        ...resolveVitestNodeArgs({ ...process.env, ...project.config.env }),
        ...project.config.execArgv,
      ]),
    ];
  }
}
