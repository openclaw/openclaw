import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { registerSignalExitBarrier } from "../cli/signal-exit-barrier.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import {
  parseUpdateDoctorLintReport,
  UPDATE_DOCTOR_DISPOSAL_WARNING_PREFIX,
} from "../infra/update-doctor-lint.js";
import { resolveUpdateRehearsalRoot } from "../infra/update-rehearsal-paths.js";
import { resolveCommandProcessSignal } from "../process/exec-spawn.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";
import { drainProcessOutput } from "../process/output-drain.js";
import { scheduleAbsoluteDeadline } from "../utils/absolute-deadline.js";
import type { DoctorLintCliOptions } from "./doctor-lint-options.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;

/** The copied rehearsal may stop its private inspector after its checks have reported. */
export async function runUpdateDoctorLintProcess(
  opts: DoctorLintCliOptions,
  disposalDeadlineMs?: number,
): Promise<number> {
  if (!resolveUpdateRehearsalRoot(process.env) || opts.json !== true) {
    throw new Error("Doctor lint worker requires an isolated update rehearsal in JSON mode.");
  }
  const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.doctorLint);
  const controller = new AbortController();
  const callerSignal = resolveCommandProcessSignal();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  const started = Date.now();
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let report: ReturnType<typeof parseUpdateDoctorLintReport> | undefined;
  let reportedAt: number | undefined;
  let disposalTerminationRequested = false;
  let callerAborted = false;
  let outputError: Error | undefined;
  let cancelDisposalDeadline: (() => void) | undefined;
  let worker: ReturnType<typeof runUtf8CommandWithTimeout> | undefined;
  const releaseBarrier = registerSignalExitBarrier(async () => {
    callerAborted = true;
    controller.abort();
    await worker;
  });
  const onOutputError = (error: Error) => {
    outputError ??= error;
    controller.abort();
  };
  process.stdout.on("error", onOutputError);
  process.stderr.on("error", onOutputError);
  try {
    worker = runUtf8CommandWithTimeout([process.execPath, ...resolveRuntimeWorkerArgv(workerUrl)], {
      input: JSON.stringify(opts),
      baseEnv: process.env,
      ...(/\.[cm]?ts$/.test(fileURLToPath(workerUrl))
        ? { env: { TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../tsconfig.json", workerUrl)) } }
        : {}),
      signal,
      killProcessTree: true,
      requireProcessTreeExtinction: true,
      killSignal: "SIGKILL",
      maxOutputBytes: MAX_OUTPUT_BYTES,
      terminateOnOutputError: true,
      terminateOnOutputLimit: true,
      onOutputChunk(chunk, stream) {
        if (stream === "stderr") {
          process.stderr.write(chunk);
          return;
        }
        pending += decoder.write(chunk);
        if (report) {
          if (pending.trim()) {
            throw new Error("Doctor lint worker emitted output after its readiness report.");
          }
          return;
        }
        const newline = pending.indexOf("\n");
        if (newline < 0) {
          return;
        }
        const line = pending.slice(0, newline);
        const parsed = parseUpdateDoctorLintReport(line);
        pending = pending.slice(newline + 1);
        if (pending.trim()) {
          throw new Error("Doctor lint worker emitted more than one readiness report.");
        }
        report = parsed;
        reportedAt = Date.now();
        process.stdout.write(`${line}\n`);
        const allowance = Math.max(5_000, reportedAt - started);
        cancelDisposalDeadline = scheduleAbsoluteDeadline(
          Math.min(reportedAt + allowance, disposalDeadlineMs ?? Infinity),
          () => {
            disposalTerminationRequested = true;
            controller.abort();
          },
        );
      },
    });
    const result = await worker;
    if (
      callerAborted ||
      callerSignal?.aborted ||
      outputError ||
      result.outputErrorStream ||
      result.outputLimitExceeded ||
      result.cleanup === "uncertain"
    ) {
      // Fixed labels keep every observed refusal inside the update fact's 200-character cap.
      const reasons = [
        callerAborted && "signal-barrier",
        callerSignal?.aborted && "caller-signal",
        outputError && "output-error",
        result.outputErrorStream && "worker-output",
        result.outputLimitExceeded && "output-limit",
        result.cleanup === "uncertain" && "cleanup-uncertain",
      ].filter(Boolean);
      const context = [
        disposalTerminationRequested && "disposal-requested",
        result.killIssuedByAbort && "kill-issued-by-abort",
        `termination=${result.termination}`,
      ].filter(Boolean);
      throw new Error(
        `Doctor lint settlement refused: ${reasons.join(",")}; ${context.join(",")}.`,
      );
    }
    if (!report || reportedAt === undefined) {
      throw new Error("Doctor lint worker exited before reporting completed checks.");
    }
    // Recheck the complete stream so trailing data cannot turn an early result into success.
    parseUpdateDoctorLintReport(result.stdout);
    const exitCode = report.ok ? 0 : 1;
    // The runner records our abort separately from the OS signal, which can be null.
    // Independent exits or signals can also require forced descendant cleanup.
    const stoppedDisposal =
      disposalTerminationRequested && result.killIssuedByAbort && result.cleanup === "forced";
    if (stoppedDisposal) {
      process.stderr.write(
        `${UPDATE_DOCTOR_DISPOSAL_WARNING_PREFIX} timed out after ${Date.now() - reportedAt}ms; checks completed.\n`,
      );
    }
    if ((result.termination === "exit" && result.code === exitCode) || stoppedDisposal) {
      await new Promise<void>((resolve) => {
        drainProcessOutput(resolve);
      });
      if (outputError || callerAborted || callerSignal?.aborted) {
        const reasons = [
          callerAborted && "signal-barrier",
          callerSignal?.aborted && "caller-signal",
          outputError && "output-error",
        ].filter(Boolean);
        throw new Error(`Doctor lint output-drain refused: ${reasons.join(",")}.`);
      }
      return exitCode;
    }
    throw new Error(
      `Doctor lint worker exited unexpectedly after reporting checks (${result.termination}, code ${result.code}).`,
    );
  } catch (error) {
    if (!report) {
      throw error;
    }
    // The readiness envelope has already been published; failures must not append another JSON.
    process.stderr.write(`[openclaw] Reason: ${scrubDoctorErrorMessage(error)}\n`);
    return 2;
  } finally {
    cancelDisposalDeadline?.();
    releaseBarrier();
    process.stdout.off("error", onOutputError);
    process.stderr.off("error", onOutputError);
  }
}
