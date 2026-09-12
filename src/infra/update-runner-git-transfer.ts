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

function recordStagingFailure(
  step: RunStepOptions,
  name: string,
  command: string,
  message: string,
  durationMs = 0,
): undefined {
  const failure: UpdateStepResult = {
    name,
    command,
    cwd: step.cwd,
    durationMs,
    exitCode: 1,
    stderrTail: message,
  };
  step.results?.push(failure);
  step.progress?.onStepComplete?.({ ...failure, index: step.stepIndex, total: step.totalSteps });
  return undefined;
}

/** Prepare a self-contained pack before admission can stop the serving gateway. */
export async function prepareGitCandidateTransfer(params: {
  candidateSha: string;
  beforeSha: string | null;
  installedRoot: string;
  upstreamRef?: string;
  step: RunStepOptions;
}) {
  const { candidateSha, beforeSha, installedRoot, upstreamRef, step } = params;
  const runGit = async (name: string, args: string[], input?: string, root = step.cwd) => {
    let stdout = "";
    const result = await runStep({
      ...step,
      name,
      cwd: root,
      argv: ["git", "-C", root, ...args],
      runCommand: async (argv, options) => {
        // Transfer inputs must never be silently truncated by diagnostic capture.
        const commandResult = await step.runCommand(argv, {
          ...options,
          input,
          terminateOnOutputLimit: true,
        });
        stdout = commandResult.stdout;
        // Object inventories are transfer input, not operator diagnostics.
        return args.includes("rev-list") || args.includes("cat-file")
          ? { ...commandResult, stdout: "" }
          : commandResult;
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
  const retained = new Set<string>();
  // Capability probing is read-only. Older Git safely transfers the full bounded
  // candidate instead of risking a lazy fetch while checking installed objects.
  const probe = beforeSha
    ? await step.runCommand(["git", "--no-lazy-fetch", "version"], {
        cwd: installedRoot,
        timeoutMs: step.timeoutMs,
      })
    : undefined;
  if (
    probe?.code === 0 &&
    probe.stdout.startsWith("git version ") &&
    !probe.killed &&
    !probe.signal &&
    (!probe.termination || probe.termination === "exit")
  ) {
    const beforeTree = await runGit("git retained tree", [
      "rev-list",
      "--objects",
      "--no-object-names",
      `${beforeSha}^{tree}`,
    ]);
    if (beforeTree === undefined) {
      return undefined;
    }
    const local = await runGit(
      "git retained object availability",
      ["--no-lazy-fetch", "cat-file", "--batch-check=%(objectname) %(objecttype)"],
      `${beforeTree}\n`,
      installedRoot,
    );
    if (local === undefined) {
      return undefined;
    }
    const pending = new Set(beforeTree.split("\n"));
    for (const line of local.split("\n")) {
      const [oid, type, ...extra] = line.split(" ");
      if (
        !oid ||
        !type ||
        extra.length ||
        !pending.delete(oid) ||
        !["blob", "tree", "missing"].includes(type)
      ) {
        return recordStagingFailure(
          { ...step, cwd: installedRoot },
          "git retained object inventory",
          "verify retained Git object availability",
          "Incomplete retained Git object availability inventory",
        );
      }
      if (type !== "missing") {
        retained.add(oid);
      }
    }
    if (pending.size) {
      return recordStagingFailure(
        { ...step, cwd: installedRoot },
        "git retained object inventory",
        "verify retained Git object availability",
        "Incomplete retained Git object availability inventory",
      );
    }
  }
  // Only physically available retained-HEAD objects are safe to borrow. Objects
  // left unreferenced by an earlier failed update can disappear during repack.
  const input = [...new Set(`${objects}\n${tree}`.split("\n").filter(Boolean))]
    .filter((oid) => !retained.has(oid))
    .map((oid) => `${oid}\n`)
    .join("");
  const prefix = path.join(step.cwd, "update-candidate");
  // Explicit objects and file output produce a non-thin pack: no excluded delta
  // base can trigger a lazy network fetch when the installed Git imports it.
  // A configured packSizeLimit also needs clearing to guarantee a single pack.
  const hash = await runGit(
    "git pack candidate",
    ["-c", "pack.packSizeLimit=0", "pack-objects", "--max-pack-size=0", prefix],
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
    return recordStagingFailure(
      step,
      "git candidate pack read",
      `read candidate pack ${packPath}`,
      `Cannot stage candidate Git pack: ${String(error)}`,
      Date.now() - readStarted,
    );
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
