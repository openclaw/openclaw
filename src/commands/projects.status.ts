import type { OutputRuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

export type ProjectsStatusOptions = {
  name: string;
  json?: boolean;
};

/** Placeholder -- full implementation in Plan 08-02. */
export async function projectsStatusCommand(
  opts: ProjectsStatusOptions,
  _runtime: OutputRuntimeEnv = defaultRuntime,
): Promise<void> {
  throw new Error(`projects status not yet implemented (project: ${opts.name})`);
}
