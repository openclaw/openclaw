import type { OutputRuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

export type ProjectsReindexOptions = {
  json?: boolean;
};

/** Placeholder -- full implementation in Plan 08-02. */
export async function projectsReindexCommand(
  opts: ProjectsReindexOptions,
  _runtime: OutputRuntimeEnv = defaultRuntime,
): Promise<void> {
  throw new Error(`projects reindex not yet implemented (json: ${opts.json})`);
}
