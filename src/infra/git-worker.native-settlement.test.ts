import fs from "node:fs/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createEnteredGate } from "../agents/entered-gate.test-support.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { runCommandBuffered } from "../process/exec.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { executeGitCommandBuffered, executeGitCommandBytes } from "./git-exec.js";
import {
  exists,
  gitResult,
  repository,
  settle,
  waitForLifecyclePoint,
  within,
} from "./git-worker-lifecycle.test-support.js";
import { runGitWorkerOperation } from "./git-worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await drainGlobalSingletonLifecycleState();
});

it.runIf(process.platform !== "win32")(
  "retains native buffered cleanup uncertainty and snapshot artifacts after cancellation",
  async () => {
    const root = tempDirs.make("openclaw-git-native-settlement-");
    const repo = await repository(root);
    const held = createEnteredGate();
    const abort = new AbortController();
    let temporaryDirectory = "";
    let completed = false;
    const pending = settle(
      runGitWorkerOperation(
        {
          type: "worktree.snapshot",
          input: {
            worktreeId: "native-buffered-settlement",
            checkoutPath: repo,
            repoRoot: repo,
            reason: "fixture",
            provisionedPaths: [],
          },
        },
        {
          signal: abort.signal,
          onEffect: (effect) => {
            if (
              effect.type === "worktree.snapshot-capacity" &&
              effect.input.purpose === "worktree safety snapshot"
            ) {
              temporaryDirectory = effect.input.demands[1]?.path ?? "";
            }
            return undefined;
          },
          git: {
            text: executeGitCommandBytes,
            buffered: async (cwd, args, options) => {
              if (!temporaryDirectory) {
                return await executeGitCommandBuffered(cwd, args, options);
              }
              // Exercise the real buffered adapter after snapshot ownership exists.
              // The child itself causes the native uncertain result; no result is injected.
              const output = await runCommandBuffered(
                [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"],
                { ...options, cwd, input: undefined },
              );
              expect(output.termination).toBe("signal");
              expect(output.signal).toBe("SIGTERM");
              await held.wait();
              return output;
            },
          },
        },
      ),
    ).then((outcome) => {
      completed = true;
      return outcome;
    });
    try {
      await waitForLifecyclePoint(held.entered, pending, "Native buffered result was not held");
      expect(await exists(temporaryDirectory)).toBe(true);
      abort.abort(new Error("snapshot cancelled while its native result is held"));
      await nextTurn();
      expect(completed).toBe(false);
      held.release();
      const outcome = await within(pending);
      expect(outcome.rejected && hasCommandProcessCleanupError(outcome.error)).toBe(true);
      expect(await exists(temporaryDirectory)).toBe(true);
      expect(
        (
          await gitResult(repo, [
            "show-ref",
            "--verify",
            "refs/openclaw/snapshots/native-buffered-settlement",
          ])
        ).code,
      ).not.toBe(0);
    } finally {
      abort.abort();
      held.release();
      await pending;
      // This fixture child exited without descendants; release only its retained directory.
      if (temporaryDirectory) {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  },
);
