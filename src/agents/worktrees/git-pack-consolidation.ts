import { randomBytes } from "node:crypto";
import path from "node:path";
import { requireGitCommandOutput } from "../../infra/git-exec.js";
import { removeTemporaryArtifacts } from "../../infra/temp-artifact-cleanup.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  hasCommandProcessCleanupError,
  readCommandProcessFailure,
} from "../../process/exec-result.js";
import * as git from "./git.js";

const log = createSubsystemLogger("agents/worktrees");

/** Bound the union before native Git publication; never retire inputs for a rejected fold. */
export async function writeConsolidatedPack(
  repoRoot: string,
  directory: string,
  selected: string[],
  bytes: number,
  promisor: boolean,
  options: NonNullable<Parameters<typeof git.runGit>[2]>,
): Promise<string | undefined> {
  // This owned prefix also participates in the existing abandoned-pack cleanup after a crash.
  const nonce = randomBytes(20).toString("hex");
  const staging = path.join(directory, `.tmp-${process.pid}-pack-${nonce}.pack`);
  const index = path.join(directory, `tmp_idx_${nonce}`);
  let retainStaging = false;
  try {
    // index-pack leaves partial files on rejection. Give it a known private name,
    // then publish only the bounded union through Git's existing atomic pack writer.
    // A staging .idx would expose an ordinary pack to concurrent promisor indexing.
    const alias =
      `!f() { if command -v ionice >/dev/null 2>&1; then ionice -c 3 -p $$ >/dev/null 2>&1; fi; git pack-objects --stdin-packs --stdout --delta-base-offset --window=10 --window-memory=8m --threads=1 | git index-pack --stdin --threads=1 --no-rev-index --max-input-size=${bytes} -o "$2" "$1" >/dev/null || return; git index-pack --stdin --threads=1` +
      (promisor ? " --promisor" : "") +
      ' < "$1"; }; f';
    const result = await git.runGit(
      repoRoot,
      ["-c", `alias.openclaw-consolidate=${alias}`, "openclaw-consolidate", staging, index],
      {
        ...options,
        env: { ...options.env, LC_ALL: "C" },
        input: `${selected.join("\n")}\n`,
      },
    );
    retainStaging = result.cleanup === "uncertain";
    if (
      !retainStaging &&
      result.termination === "exit" &&
      result.code === 128 &&
      result.stderr.includes("fatal: pack exceeds maximum allowed size (")
    ) {
      log.warn(
        `Skipped Git pack consolidation in ${repoRoot}: output exceeds ${bytes} input bytes; inputs retained.`,
      );
      return undefined;
    }
    const hash = /^pack\s+([a-f0-9]{40}|[a-f0-9]{64})$/.exec(
      requireGitCommandOutput("git pack consolidation", result).trim(),
    )?.[1];
    if (!hash) {
      throw new Error("Git pack consolidation returned an invalid pack identity");
    }
    return hash;
  } catch (error) {
    retainStaging ||=
      hasCommandProcessCleanupError(error) ||
      readCommandProcessFailure(error)?.cleanup === "uncertain";
    throw error;
  } finally {
    if (!retainStaging) {
      await Promise.all(
        [staging, index].map((file) => removeTemporaryArtifacts(file, "Git consolidation")),
      );
    }
  }
}
