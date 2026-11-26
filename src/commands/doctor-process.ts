import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { registerSignalExitGate } from "../cli/signal-exit-barrier.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../infra/runtime-worker-url.js";
import { CommandProcessCleanupError, readCommandProcessCleanup } from "../process/exec-result.js";
import {
  resolveCommandProcessSignal,
  retainCommandProcessCleanup,
  runOutsideCommandProcessScope,
} from "../process/exec-spawn.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Hosted Doctor keeps its synchronous checks and process-global state outside the Gateway. */
export async function runDoctorProcess(runtime: RuntimeEnv): Promise<void> {
  const signal = resolveCommandProcessSignal(getAsyncWorkSignal());
  signal?.throwIfAborted();
  const cancellation = new AbortController();
  const workerUrl = resolveRuntimeProcessEntrypointUrl("doctor");
  const output = {
    stdout: { decoder: new StringDecoder("utf8"), pending: "", write: runtime.log },
    stderr: { decoder: new StringDecoder("utf8"), pending: "", write: runtime.error },
  };
  let remaining = MAX_OUTPUT_BYTES;
  let truncated = false;
  let outputFailure: { error: unknown } | undefined;
  const write = (stream: keyof typeof output, text: string) => {
    if (outputFailure) {
      return;
    }
    try {
      output[stream].write(text);
    } catch (error) {
      outputFailure = { error };
      cancellation.abort(error);
    }
  };
  const append = (stream: keyof typeof output, text: string) => {
    const state = output[stream];
    state.pending += text;
    let newline: number;
    while ((newline = state.pending.indexOf("\n")) >= 0) {
      write(stream, state.pending.slice(0, newline));
      state.pending = state.pending.slice(newline + 1);
    }
  };
  // Hosted diagnosis is read-only. Bound its lifetime, then join process-tree cleanup.
  const worker = trackAsyncWork(async () => {
    const result = await runOutsideCommandProcessScope(() =>
      runUtf8CommandWithTimeout([process.execPath, ...resolveRuntimeWorkerArgv(workerUrl)], {
        input: "",
        timeoutMs: 120_000,
        signal: signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal,
        cwd: process.cwd(),
        baseEnv: process.env,
        ...(/\.[cm]?ts$/.test(fileURLToPath(workerUrl))
          ? { env: { TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../tsconfig.json", workerUrl)) } }
          : {}),
        killProcessTree: true,
        requireProcessTreeExtinction: true,
        outputCapture: "discard",
        onOutputChunk(chunk, stream) {
          const accepted = chunk.subarray(0, remaining);
          remaining -= accepted.byteLength;
          truncated ||= accepted.byteLength < chunk.byteLength;
          append(stream, output[stream].decoder.write(accepted));
        },
      }),
    );
    // Output can arrive before process identity preparation finishes. An abort in
    // that interval returns a provisional outcome with the existing cleanup owner.
    const pendingCleanup = readCommandProcessCleanup(result);
    const cleanup = pendingCleanup
      ? await pendingCleanup.catch((cause: unknown) => {
          throw new CommandProcessCleanupError({ cause });
        })
      : result.cleanup;
    if (cleanup === "uncertain") {
      throw new CommandProcessCleanupError();
    }
    return result;
  });
  const settlement = worker.then(() => undefined);
  void settlement.catch(() => {});
  retainCommandProcessCleanup(settlement);
  const releaseExitGate = registerSignalExitGate(settlement, () => cancellation.abort());
  try {
    const result = await worker;
    for (const stream of ["stdout", "stderr"] as const) {
      if (!truncated) {
        append(stream, output[stream].decoder.end());
      }
      if (output[stream].pending) {
        write(stream, output[stream].pending);
      }
    }
    if (outputFailure) {
      throw outputFailure.error;
    }
    signal?.throwIfAborted();
    if (truncated) {
      runtime.error(
        "Doctor output was truncated after 1 MiB. Run `openclaw doctor --lint` on this host for the complete report.",
      );
    }
    if (result.outputErrorStream) {
      throw new Error(`Doctor ${result.outputErrorStream} output could not be read.`);
    }
    if (result.termination !== "exit") {
      throw new Error(
        `Doctor diagnosis did not complete (${result.termination}); no repairs were applied.`,
      );
    }
    if (result.code !== 0) {
      runtime.exit(result.code ?? 1);
    }
  } finally {
    releaseExitGate();
  }
}
