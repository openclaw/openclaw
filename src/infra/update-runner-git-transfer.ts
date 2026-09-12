import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "./errno.js";
import { readLocalFileSafely } from "./fs-safe.js";
import { runStep } from "./update-runner-command.js";
import type { RunStepOptions, UpdateStepResult } from "./update-runner-types.js";

// Bound the retained import buffer independently of Git's pack-file size. An
// oversized candidate must fail in staging while the installed runtime still serves.
const MAX_CANDIDATE_PACK_BYTES = 256 * 1024 * 1024;

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
        // Transfer inputs must never be silently truncated by diagnostic capture.
        const commandResult = await step.runCommand(argv, {
          ...options,
          input,
          terminateOnOutputLimit: true,
        });
        stdout = commandResult.stdout;
        // Object inventories are transfer input, not operator diagnostics.
        return args[0] === "rev-list" ? { ...commandResult, stdout: "" } : commandResult;
      },
    });
    // A process may exit zero after handling the output-limit termination signal.
    // Its captured object list is still incomplete and must never be admitted.
    return result.exitCode === 0 &&
      !result.killed &&
      !result.signal &&
      (!result.termination || result.termination === "exit")
      ? stdout.trim()
      : undefined;
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
  // The shared mirror borrows installed objects; --local avoids repacking them.
  const hash = await runGit(
    "git pack candidate",
    ["pack-objects", "--local", "--max-pack-size=0", prefix],
    input,
  );
  if (!hash) {
    return undefined;
  }
  let pack: Buffer;
  const packPath = `${prefix}-${hash}.pack`;
  const readStarted = Date.now();
  try {
    ({ buffer: pack } = await readLocalFileSafely({
      filePath: packPath,
      maxBytes: MAX_CANDIDATE_PACK_BYTES,
    }));
  } catch (error) {
    const failure: UpdateStepResult = {
      name: "git candidate pack read",
      command: `read candidate pack ${packPath}`,
      cwd: step.cwd,
      durationMs: Date.now() - readStarted,
      exitCode: 1,
      stderrTail: `Cannot stage candidate Git pack: ${String(error)}`,
    };
    step.results?.push(failure);
    step.progress?.onStepComplete?.({ ...failure, index: step.stepIndex, total: step.totalSteps });
    return undefined;
  }
  const keepMessage = `openclaw-update-${randomUUID()}`;
  return {
    async importInto(target: RunStepOptions): Promise<boolean> {
      const imported = await runStep({
        ...target,
        // Repack may run before checkout makes the candidate reachable. Keep its
        // pack until activation/rollback finishes, including source publication.
        argv: ["git", "-C", target.cwd, "index-pack", "--stdin", `--keep=${keepMessage}`],
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
    async cleanup(target: RunStepOptions): Promise<void> {
      try {
        // Resolve at cleanup time: publication may have moved the installed repo.
        const location = await target.runCommand(
          [
            "git",
            "-C",
            target.cwd,
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            `objects/pack/pack-${hash}.keep`,
          ],
          { cwd: target.cwd, timeoutMs: target.timeoutMs },
        );
        if (location.code !== 0) {
          throw new Error("Cannot locate the retained candidate pack");
        }
        const keepPath = location.stdout.trim();
        const message = await fs.readFile(keepPath, "utf8").catch((error: unknown) => {
          if (hasErrnoCode(error, "ENOENT")) {
            return undefined;
          }
          throw error;
        });
        // index-pack never overwrites an existing keep file. Do not remove one
        // created by another updater or operator, even for an identical pack.
        if (message === `${keepMessage}\n`) {
          await fs.unlink(keepPath);
        }
      } catch (error) {
        const warning: UpdateStepResult = {
          name: "git candidate pack cleanup",
          command: "release retained candidate pack",
          cwd: target.cwd,
          durationMs: 0,
          exitCode: 1,
          stderrTail: String(error),
          advisory: {
            kind: "recoverable-maintenance",
            message: `Candidate pack remains retained: ${String(error)}`,
          },
        };
        target.results?.push(warning);
        target.progress?.onStepComplete?.({ ...warning, index: 0, total: 0 });
      }
    },
  };
}
