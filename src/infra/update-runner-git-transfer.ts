import fs from "node:fs/promises";
import path from "node:path";
import { runStep } from "./update-runner-command.js";
import type { RunStepOptions } from "./update-runner-types.js";

/** Prepare a self-contained pack before admission can stop the serving gateway. */
export async function prepareGitCandidateTransfer(params: {
  candidateSha: string;
  beforeSha: string | null;
  upstreamRef?: string;
  step: RunStepOptions;
}) {
  const { candidateSha, beforeSha, upstreamRef, step } = params;
  const runGit = async (name: string, args: string[], input?: string) => {
    let stdout = "";
    const result = await runStep({
      ...step,
      name,
      argv: ["git", "-C", step.cwd, ...args],
      runCommand: async (argv, options) => {
        const result = await step.runCommand(argv, { ...options, input });
        stdout = result.stdout;
        // Object inventories are transfer input, not operator diagnostics.
        return args[0] === "rev-list" ? { ...result, stdout: "" } : result;
      },
    });
    return result.exitCode === 0 ? stdout.trim() : undefined;
  };
  const upstreamSha = upstreamRef
    ? await runGit("git pin candidate upstream", ["rev-parse", upstreamRef])
    : undefined;
  if (upstreamRef && !upstreamSha) {
    return undefined;
  }
  const objects = await runGit("git candidate history", [
    "rev-list",
    "--objects",
    "--no-object-names",
    candidateSha,
    ...(upstreamSha ? [upstreamSha] : []),
    ...(beforeSha ? [`^${beforeSha}`] : []),
  ]);
  // An older/divergent target may reuse blobs omitted from the installed partial
  // clone. Include its entire tree separately, even when no new commits exist.
  const tree = await runGit("git candidate tree", [
    "rev-list",
    "--objects",
    "--no-object-names",
    `${candidateSha}^{tree}`,
  ]);
  if (objects === undefined || tree === undefined) {
    return undefined;
  }
  const input = [...new Set(`${objects}\n${tree}`.split("\n").filter(Boolean))].join("\n") + "\n";
  const prefix = path.join(step.cwd, "update-candidate");
  // Explicit objects and file output produce a non-thin pack: no excluded delta
  // base can trigger a lazy network fetch when the installed Git imports it.
  const hash = await runGit(
    "git pack candidate",
    ["pack-objects", "--max-pack-size=0", prefix],
    input,
  );
  if (!hash) {
    return undefined;
  }
  const pack = await fs.readFile(`${prefix}-${hash}.pack`);
  return {
    async importInto(target: RunStepOptions): Promise<boolean> {
      const imported = await runStep({
        ...target,
        argv: ["git", "-C", target.cwd, "index-pack", "--stdin"],
        runCommand: (argv, options) => target.runCommand(argv, { ...options, input: pack }),
      });
      if (imported.exitCode !== 0) {
        return false;
      }
      if (!upstreamRef || !upstreamSha) {
        return true;
      }
      const tracked = await runStep({
        ...target,
        name: "git import admitted upstream",
        argv: ["git", "-C", target.cwd, "update-ref", upstreamRef, upstreamSha],
      });
      return tracked.exitCode === 0;
    },
  };
}
