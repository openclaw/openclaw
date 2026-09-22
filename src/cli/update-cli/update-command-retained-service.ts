import { randomUUID } from "node:crypto";
import {
  withGatewayServiceUpdateAuthority,
  type GatewayServiceNativeCommand,
} from "../../daemon/service-update-authority.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  assertRetainedUpdateCommandRoot,
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";
import { prepareUpdateCommandNativeGate } from "./update-command-native-gate.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery-error.js";

/** Real retained admission plus native-controller custody, never service health. */
export async function withRetainedUpdateServiceAuthority<T>(
  params: {
    run: NonNullable<UpdateCommandOptions["run"]>;
    root: string;
    assertCurrent: () => void;
    signal?: AbortSignal;
  },
  operation: (assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  // The ordinary Windows runner has no persistent Job identity for a dead
  // gate. Do not replace that missing custody with a reusable PID/taskkill claim.
  if (process.platform === "win32") {
    throw new UpdateCommandRecoveryPendingError(
      "Retained native recovery requires Windows Job custody.",
    );
  }
  const { run, root, signal } = params;
  const executor = run.executorFence;
  const assertCaller = params.assertCurrent;
  const assertCurrent = () => {
    signal?.throwIfAborted();
    if (!executor || run.executorFence !== executor) {
      throw new UpdateCommandRecoveryPendingError("Retained service lost its original executor.");
    }
    assertRetainedUpdateCommandRoot(executor, root);
    assertCaller();
  };
  assertCurrent();
  if (!executor) {
    throw new UpdateCommandRecoveryPendingError("Retained service requires its executor.");
  }
  const candidateRoot = captureUpdateCommandExecutorAuthority(executor).installKey;
  const nativeCommand: GatewayServiceNativeCommand = async (argv, options) => {
    assertCurrent();
    const ticket = randomUUID();
    const command = [...argv];
    const nativeOptions = { ...options, baseEnv: { ...options.baseEnv }, env: { ...options.env } };
    const result = await withUpdateCommandExecutorChild(
      executor,
      candidateRoot,
      async (_grant, bind) => {
        const gate = prepareUpdateCommandNativeGate(ticket, [
          nativeOptions.baseEnv,
          nativeOptions.env,
        ]);
        const nativeResult = await runCommandWithTimeout(
          [process.execPath, "--input-type=module", "-e", gate.source, "--", ...command],
          {
            ...nativeOptions,
            baseEnv: {},
            env: gate.env,
            signal:
              signal && nativeOptions.signal
                ? AbortSignal.any([signal, nativeOptions.signal])
                : (signal ?? nativeOptions.signal),
            input: gate.input,
            beforeInput: (pid) => {
              signal?.throwIfAborted();
              // The parent fence is suspended. bind checks the same original A/B
              // owners internally, then binds both child rows before opening stdin.
              bind(pid);
            },
            killProcessTree: true,
            requireProcessTreeExtinction: true,
          },
        );
        // Classify inside child custody: neither root may be released until
        // a failed or successful native writer has settled safely.
        if (nativeResult.cleanup === "uncertain" || nativeResult.cleanup === "forced") {
          throw new CommandProcessCleanupError();
        }
        return nativeResult;
      },
    );
    assertCurrent();
    if (result.outputLimitExceeded || result.outputErrorStream) {
      throw new UpdateCommandRecoveryPendingError(
        "Retained native command cleanup is unconfirmed.",
      );
    }
    const prefix = `native-spawn-error:${ticket}:`;
    if (
      result.termination === "exit" &&
      result.code === 1 &&
      result.stdout === "" &&
      result.cleanup !== "uncertain" &&
      result.cleanup !== "forced" &&
      !result.stdoutTruncatedBytes &&
      !result.stderrTruncatedBytes &&
      result.stderr.startsWith(prefix)
    ) {
      const code = result.stderr.slice(prefix.length);
      if (/^[A-Z0-9_]+$/.test(code)) {
        throw Object.assign(
          new Error("Native command failed during launch"),
          code === "_" ? {} : { code },
        );
      }
    }
    return result;
  };
  return await withGatewayServiceUpdateAuthority(assertCurrent, () => operation(assertCurrent), {
    originalRoot: params.root,
    nativeCommand,
  });
}
