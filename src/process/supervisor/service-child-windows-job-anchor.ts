import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { WindowsJob, type WindowsJobChild } from "@openclaw/proc-safe/windows-job";
import { mergeProcessEnv, resolveEnvironmentValue } from "../../infra/process-env.js";
import { createWindowsOutputDecoder } from "../../infra/windows-encoding.js";
import { getWindowsCmdExePath } from "../../infra/windows-install-roots.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type {
  ServiceChildAnchorMessage,
  ServiceChildAnchorPayload,
  ServiceChildStart,
} from "./service-child-protocol.js";
import { isWindowsJobServiceStart } from "./service-child-windows-job-start.js";

type AnchorState = "starting" | "active" | "closing" | "closed";
type ClosingReason = Extract<ServiceChildAnchorMessage, { type: "closing" }>["reason"];
type OutputStream = {
  name: "stdout" | "stderr";
  decoder?: ReturnType<typeof createWindowsOutputDecoder>;
  ended: boolean;
};

const IDLE_OBSERVATION_MS = 10;
const OUTPUT_BUFFER_BYTES = 64 * 1024;
const OUTPUT_ROUNDS_PER_TURN = 2;

function sendProcessMessage(message: ServiceChildAnchorMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected || !process.send) {
      reject(new Error("Windows Job anchor IPC is closed"));
      return;
    }
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}

export function runServiceChildWindowsJobAnchor(): void {
  const launchGrant = createDeferredCore();
  let start: ServiceChildStart | undefined;
  let state: AnchorState = "starting";
  let sequence = 0;
  let lastHostSequence = 0;
  let outboundQueue = Promise.resolve();
  let job: WindowsJob | undefined;
  let child: WindowsJobChild | undefined;
  let rootObserved = false;
  let extinctionProven = false;
  let terminationRequested = false;
  let closeReason: ClosingReason | undefined;
  let lifecycleTimer: NodeJS.Timeout | undefined;
  let lifecycleImmediate: NodeJS.Immediate | undefined;
  let lifecycleRunning = false;
  let lifecycleRerun = false;
  const outputStreams: OutputStream[] = [];
  const startupErrorAcknowledged = createDeferredCore();
  const cleanupFinished = createDeferredCore();
  void cleanupFinished.promise.catch(() => {});

  const send = (payload: ServiceChildAnchorPayload): Promise<void> => {
    if (!start) {
      return Promise.reject(new Error("Windows Job anchor has not started"));
    }
    sequence += 1;
    const message: ServiceChildAnchorMessage = {
      ...payload,
      generation: start.generation,
      sequence,
    };
    const delivery = outboundQueue.then(() => sendProcessMessage(message));
    outboundQueue = delivery.catch(() => {});
    return delivery;
  };

  const deliver = async (payload: ServiceChildAnchorPayload): Promise<void> => {
    if (!process.connected) {
      if (!closeReason) {
        void requestCleanup("parent-lost");
      }
      return;
    }
    try {
      await send(payload);
    } catch (error) {
      if (process.connected) {
        throw error;
      }
      if (!closeReason) {
        void requestCleanup("parent-lost");
      }
    }
  };

  const stopLifecycle = () => {
    clearTimeout(lifecycleTimer);
    clearImmediate(lifecycleImmediate);
    lifecycleTimer = undefined;
    lifecycleImmediate = undefined;
  };

  const finishAnchor = (exitCode: number) => {
    stopLifecycle();
    process.exitCode = exitCode;
    if (process.connected) {
      process.disconnect?.();
    }
  };

  const closeNativeHandles = () => {
    let closeError: Error | undefined;
    for (const owner of [child, job]) {
      try {
        owner?.close();
      } catch (error) {
        closeError ??= error instanceof Error ? error : new Error(coerceErrorMessage(error));
      }
    }
    child = undefined;
    job = undefined;
    if (closeError) {
      throw closeError;
    }
  };

  const closeAuthority = async (reason: ClosingReason) => {
    if (state === "closed") {
      return;
    }
    state = "closed";
    stopLifecycle();
    try {
      if (process.connected) {
        await send({ type: "closing", reason });
      }
      closeNativeHandles();
      cleanupFinished.resolve();
      finishAnchor(0);
    } catch (error) {
      try {
        closeNativeHandles();
      } catch {
        // Preserve the original delivery/close failure while KILL_ON_JOB_CLOSE still owns cleanup.
      }
      cleanupFinished.reject(error);
      finishAnchor(1);
    }
  };

  const failAuthority = async (error: unknown) => {
    if (state === "closed") {
      return;
    }
    state = "closed";
    stopLifecycle();
    try {
      if (process.connected && start) {
        await send({ type: "result-error", error: coerceErrorMessage(error) }).catch(() => {});
      }
      closeNativeHandles();
    } catch {
      // An owner failure never receives a closing receipt or claims unobserved extinction.
    } finally {
      cleanupFinished.reject(error);
      finishAnchor(1);
    }
  };

  const finishOutput = async (stream: OutputStream) => {
    if (stream.ended) {
      return;
    }
    stream.ended = true;
    const tail = stream.decoder?.flush();
    if (tail) {
      await deliver({ type: "output", stream: stream.name, chunk: tail });
    }
    await deliver({ type: "output-end", stream: stream.name });
  };

  const observeOutput = async (stream: OutputStream): Promise<boolean> => {
    if (stream.ended) {
      return false;
    }
    if (!child || !stream.decoder) {
      throw new Error(`${stream.name} output ownership was not initialized`);
    }
    const bytes =
      stream.name === "stdout"
        ? child.readStdout(OUTPUT_BUFFER_BYTES)
        : child.readStderr(OUTPUT_BUFFER_BYTES);
    if (bytes === null) {
      await finishOutput(stream);
      return true;
    }
    if (bytes.length === 0) {
      return false;
    }
    const text = stream.decoder.decode(bytes);
    if (text) {
      await deliver({ type: "output", stream: stream.name, chunk: text });
    }
    return true;
  };

  const observeRoot = async (): Promise<boolean> => {
    if (rootObserved) {
      return false;
    }
    if (!child) {
      throw new Error("Windows root process ownership was not initialized");
    }
    const code = child.exitCode();
    if (code === null) {
      return false;
    }
    rootObserved = true;
    await deliver({ type: "root-result", code, signal: null });
    return true;
  };

  const observeJob = (): boolean => {
    if (extinctionProven) {
      return false;
    }
    if (!job) {
      throw new Error("Windows Job ownership was not initialized");
    }
    extinctionProven = job.accounting().activeProcesses === 0;
    return extinctionProven;
  };

  const runLifecycle = async () => {
    if (lifecycleRunning || state === "closed" || !child) {
      lifecycleRerun ||= lifecycleRunning;
      return;
    }
    lifecycleRunning = true;
    let advanced = false;
    try {
      advanced = (await observeRoot()) || advanced;
      // The admitted root itself proves the Job is nonempty until its exact HANDLE signals.
      advanced = (rootObserved && observeJob()) || advanced;
      for (let round = 0; round < OUTPUT_ROUNDS_PER_TURN; round += 1) {
        let outputAdvanced = false;
        for (const stream of outputStreams) {
          outputAdvanced = (await observeOutput(stream)) || outputAdvanced;
        }
        advanced ||= outputAdvanced;
        if (!outputAdvanced) {
          break;
        }
      }
      if (extinctionProven && rootObserved && outputStreams.every((stream) => stream.ended)) {
        await closeAuthority(closeReason ?? "lineage-closed");
        return;
      }
    } catch (error) {
      await failAuthority(error);
      return;
    } finally {
      lifecycleRunning = false;
    }
    const immediate = advanced || lifecycleRerun;
    lifecycleRerun = false;
    scheduleLifecycle(immediate);
  };

  const scheduleLifecycle = (immediate: boolean) => {
    if (state === "closed" || !child) {
      return;
    }
    if (lifecycleRunning) {
      lifecycleRerun ||= immediate;
      return;
    }
    if (immediate && lifecycleTimer) {
      clearTimeout(lifecycleTimer);
      lifecycleTimer = undefined;
    }
    if (lifecycleTimer || lifecycleImmediate) {
      return;
    }
    if (immediate) {
      lifecycleImmediate = setImmediate(() => {
        lifecycleImmediate = undefined;
        void runLifecycle();
      });
      return;
    }
    lifecycleTimer = setTimeout(() => {
      lifecycleTimer = undefined;
      void runLifecycle();
    }, IDLE_OBSERVATION_MS);
    // A disconnected IPC channel cannot retain Node; cleanup must retain its exact Job owner.
    if (state === "active" && process.connected) {
      lifecycleTimer.unref();
    }
  };

  const requestCleanup = (reason: "cancel" | "parent-lost" | "lineage-lost"): Promise<void> => {
    if (state === "closed") {
      return cleanupFinished.promise;
    }
    closeReason ??= reason;
    state = "closing";
    if (!child) {
      void closeAuthority(reason);
      return cleanupFinished.promise;
    }
    if (!terminationRequested && !extinctionProven) {
      terminationRequested = true;
      try {
        if (!job) {
          throw new Error("Windows Job cleanup authority was not initialized");
        }
        job.terminate(1);
      } catch (error) {
        void failAuthority(error);
        return cleanupFinished.promise;
      }
    }
    scheduleLifecycle(true);
    return cleanupFinished.promise;
  };

  const reportStartupError = async (error: unknown) => {
    if (!process.connected) {
      return;
    }
    await send({ type: "startup-error", error: coerceErrorMessage(error) });
    await startupErrorAcknowledged.promise;
  };

  const startCommand = async (next: ServiceChildStart) => {
    start = next;
    if (typeof next.windowsShellCommand !== "string") {
      state = "closed";
      finishAnchor(1);
      return;
    }
    try {
      job = WindowsJob.create();
      if (next.type === "prepare") {
        await send({ type: "prepared" });
        await Promise.race([launchGrant.promise, cleanupFinished.promise]);
        if (state !== "starting") {
          return;
        }
      }
      const shell =
        resolveEnvironmentValue(next.env, "COMSPEC", "win32") || getWindowsCmdExePath(next.env);
      // Admission and the inherited-handle allowlist are atomic inside the native owner.
      child = job.spawn({
        executable: shell,
        commandLine: `"${shell}" /d /s /c "${next.windowsShellCommand}"`,
        cwd: next.cwd,
        // ARM64 cmd.exe needs SystemRoot even when the command replaces its environment.
        env:
          next.env === undefined
            ? undefined
            : mergeProcessEnv(
                [
                  { SystemRoot: resolveEnvironmentValue(process.env, "SystemRoot", "win32") },
                  next.env,
                ],
                "win32",
              ),
      });
      const commandPid = child.pid;
      outputStreams.push({ name: "stdout", ended: false }, { name: "stderr", ended: false });
      for (const stream of outputStreams) {
        stream.decoder = createWindowsOutputDecoder();
      }

      state = "active";
      const readyDelivery = send({ type: "ready", commandPid, anchorPid: process.pid });
      // Queue ready before polling so an instantly exiting command cannot overtake admission.
      scheduleLifecycle(true);
      await readyDelivery;
    } catch (error) {
      if (state === "closed") {
        return;
      }
      if (state === "closing") {
        await cleanupFinished.promise.catch(() => {});
        return;
      }
      if (child && outputStreams.some((stream) => !stream.decoder)) {
        for (const stream of outputStreams) {
          stream.ended = true;
        }
      }
      await reportStartupError(error);
      await (child ? requestCleanup("lineage-lost") : closeAuthority("lineage-lost"));
    }
  };

  process.once("disconnect", () => {
    startupErrorAcknowledged.resolve();
    if (!start) {
      state = "closed";
      process.exitCode = 1;
      return;
    }
    void requestCleanup("parent-lost");
  });
  process.once("SIGTERM", () => void requestCleanup("parent-lost"));
  process.once("SIGINT", () => void requestCleanup("parent-lost"));
  process.on("message", (raw: unknown) => {
    if (isWindowsJobServiceStart(raw) && start === undefined && state === "starting") {
      void startCommand(raw);
      return;
    }
    const message = asOptionalRecord(raw);
    if (
      !start ||
      state === "closed" ||
      !message ||
      (message.type !== "cancel" &&
        message.type !== "startup-error-ack" &&
        message.type !== "launch") ||
      typeof message.generation !== "string" ||
      typeof message.sequence !== "number" ||
      message.generation !== start.generation ||
      message.sequence <= lastHostSequence
    ) {
      if (start && state !== "closed") {
        void requestCleanup("lineage-lost");
      }
      return;
    }
    lastHostSequence = message.sequence;
    if (message.type === "launch") {
      launchGrant.resolve();
    } else if (message.type === "startup-error-ack") {
      startupErrorAcknowledged.resolve();
    } else {
      void requestCleanup("cancel");
    }
  });
}

runServiceChildWindowsJobAnchor();
