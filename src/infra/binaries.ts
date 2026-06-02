import { runExec } from "../process/exec.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

/** Verifies that a required executable is available before a command path continues. */
export async function ensureBinary(
  name: string,
  exec: typeof runExec = runExec,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  // Abort early if a required CLI tool is missing.
  await exec("which", [name]).catch(() => {
    runtime.error(`Missing required binary: ${name}. Please install it.`);
    runtime.exit(1);
  });
}
