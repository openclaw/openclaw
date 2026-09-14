import { randomUUID } from "node:crypto";
import {
  withGatewayServiceUpdateAuthority,
  type GatewayServiceNativeCommand,
} from "../../daemon/service-update-authority.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { UpdateCommandOptions } from "./shared.js";
import {
  assertRetainedUpdateCommandRoot,
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";

// This loaded source literal survives package replacement. It only gates a native
// argv on its private pipe; it does not load A/B modules or interpret update grants.
// The gate and controller share the process group owned by the existing runner.
const nativeCommandGate = `
  const { spawn } = await import("node:child_process");
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 36) process.exit(1);
  }
  if (!/^[0-9a-f-]{36}$/.test(input)) process.exit(1);
  const child = spawn(process.argv[1], process.argv.slice(2), {
    stdio: ["ignore", "inherit", "inherit"], detached: false, windowsHide: true,
  });
  let spawnFailed = false;
  child.once("error", (error) => {
    spawnFailed = true;
    const code = typeof error.code === "string" && /^[A-Z0-9_]+$/.test(error.code) ? error.code : "_";
    process.stderr.write("native-spawn-error:" + input + ":" + code);
    process.exitCode = 1;
  });
  child.once("close", (code, signal) => {
    if (spawnFailed) return;
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
`;

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
      async (_grant, bind) =>
        runCommandWithTimeout(
          [process.execPath, "--input-type=module", "-e", nativeCommandGate, "--", ...command],
          {
            ...nativeOptions,
            signal:
              signal && nativeOptions.signal
                ? AbortSignal.any([signal, nativeOptions.signal])
                : (signal ?? nativeOptions.signal),
            input: ticket,
            beforeInput: (pid) => {
              signal?.throwIfAborted();
              // The parent fence is suspended. bind checks the same original A/B
              // owners internally, then binds both child rows before opening stdin.
              bind(pid);
            },
            killProcessTree: true,
            requireProcessTreeExtinction: true,
          },
        ),
    );
    assertCurrent();
    if (
      (result.termination === "exit" &&
        result.code === 0 &&
        (result.cleanup === "uncertain" || result.cleanup === "forced")) ||
      result.outputLimitExceeded ||
      result.outputErrorStream
    ) {
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
  return await withGatewayServiceUpdateAuthority(
    assertCurrent,
    () => operation(assertCurrent),
    nativeCommand,
  );
}
