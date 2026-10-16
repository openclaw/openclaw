import { fileURLToPath } from "node:url";
import { runNodeScript } from "../../test/helpers/run-node-script.js";

export const profilePackageRoot = fileURLToPath(new URL("../../", import.meta.url));

export function runNativeProfile(
  ownerUrl: URL,
  source: string,
  signal: AbortSignal,
  exposeGc = false,
) {
  // Do not pass coverage, debugger options, or test-worker mocks to the child.
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "OPENCLAW_STATE_DIR", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key]) {
      env[key] = process.env[key];
    }
  }
  return runNodeScript(
    (workerArgv) => [
      ...workerArgv(ownerUrl).slice(0, -1),
      ...(exposeGc ? ["--expose-gc"] : []),
      "--input-type=module",
      "--eval",
      source,
    ],
    env,
    20_000,
    {
      cwd: profilePackageRoot,
      signal,
      maxBuffer: 32_768,
      requireProcessTreeExit: true,
      executable: process.execPath,
    },
  );
}
