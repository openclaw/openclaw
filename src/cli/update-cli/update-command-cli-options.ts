import { stripVTControlCharacters } from "node:util";
import { resolveOpenClawCliInvocation } from "../../../cli-invocation.mjs";
import { runExec, type RunExecOptions } from "../../process/exec.js";

/** Same-version artifacts can advertise different options; inspect the selected target. */
export async function readUpdateTargetCliOptions(
  params: { nodeRunner: string; entryPath: string; command: "doctor" | "update" },
  options: RunExecOptions,
): Promise<Set<string>> {
  const invocation = resolveOpenClawCliInvocation({
    execPath: params.nodeRunner,
    entryPath: params.entryPath,
    execArgv: [],
    args: [params.command, "--help"],
  });
  const { stdout } = await runExec(invocation.command, invocation.args, {
    ...options,
    logOutput: false,
  });
  return new Set(
    Array.from(
      stripVTControlCharacters(stdout).matchAll(/^[\t ]*--[a-z][a-z-]*(?:[\t ]|$)/gm),
      (match) => match[0].trim(),
    ),
  );
}
