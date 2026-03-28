import type { OutputRuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";

export type ProjectsValidateOptions = {
  json?: boolean;
};

/** Placeholder -- full implementation in Plan 08-02. */
export async function projectsValidateCommand(
  opts: ProjectsValidateOptions,
  _runtime: OutputRuntimeEnv = defaultRuntime,
): Promise<void> {
  throw new Error(`projects validate not yet implemented (json: ${opts.json})`);
}
