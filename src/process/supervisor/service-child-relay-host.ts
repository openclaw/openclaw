import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { Duplex, Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { extractErrorCode, toErrorObject } from "../../infra/errors.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { joinProcessCompletionAndOutput } from "../decoded-output.js";
import { pipeProcessOutput } from "../pipe-output.js";
import { spawnServiceChildRelay } from "../spawn-broker/relay-integration.js";
import { createManagedChildStdin } from "./adapters/child-stdin.js";
import { toStringEnv } from "./adapters/env.js";
import { createProcessAdapterEvents } from "./adapters/process-events.js";
import { createServiceChildCleanupDeadline } from "./service-child-cleanup-deadline.js";
import { readServiceChildControl } from "./service-child-control-reader.js";
import { isOwnedProcessGroupGone } from "./service-child-group-ownership.js";
import { createOutputRelay } from "./service-child-output-relay.js";
import {
  encodeServiceChildMessage,
  type ServiceChildAnchorMessage,
  type ServiceChildControlMessage,
  type ServiceChildRelayMessage,
  type ServiceChildStart,
} from "./service-child-protocol.js";
import {
  prepareServiceChildRelay,
  type ServiceChildRelayParams,
} from "./service-child-relay-preparation.js";
import { createServiceChildRelayRetirement } from "./service-child-relay-retirement.js";
import type { ProcessAdapterStartup, SpawnProcessAdapter } from "./types.js";

type ServiceChildRelayAdapter = SpawnProcessAdapter<NodeJS.Signals | null> & {
  waitForExtinction: () => Promise<void>;
  confirmExtinction: () => boolean;
  openStartGate?: () => Promise<void>;
  closeStartGate?: () => void;
} & Required<Pick<SpawnProcessAdapter<NodeJS.Signals | null>, "onExit" | "onError">>;
type AuthorityState = "starting" | "active" | "closing" | "closed" | "identity-lost";

function readChildMessage(raw: unknown): ServiceChildRelayMessage | ServiceChildAnchorMessage {
  // SAFETY: the spawned relay or Job anchor is the sole writer on each private protocol channel.
  return raw as ServiceChildRelayMessage | ServiceChildAnchorMessage;
}

export async function createServiceChildRelayAdapter(
  params: ServiceChildRelayParams,
): Promise<ProcessAdapterStartup<ServiceChildRelayAdapter>> {
  const generation = randomUUID();
  using preparation = prepareServiceChildRelay(params);
  const { useWindowsJobAnchor, controlFd, lineageFd } = preparation;

  if (params.abortSignal?.aborted) {
    throw new Error("service child construction aborted");
  }
  params.assertCurrent?.();
  params.beforeSpawn?.();
  const { child, cleanup, transportReady } = spawnServiceChildRelay({
    ...preparation.spawn,
    onSpawnCleanup: params.onSpawnCleanup,
  });
  if (transportReady) {
    await transportReady;
  }

  // SAFETY: a defined controlFd was reserved as a pipe in this exact spawn stdio array.
  const control = controlFd === undefined ? null : (child.stdio[controlFd] as Duplex | null);
  // Its reader stays outside the killed process group, including escaped writers.
  // SAFETY: lineageFd was reserved as a pipe in this exact spawn stdio array.
  const lineage = lineageFd === undefined ? null : (child.stdio[lineageFd] as Readable | null);
  if (
    !child.connected ||
    (!useWindowsJobAnchor && (!control || !lineage || !child.stdout || !child.stderr))
  ) {
    child.kill("SIGKILL");
    const error = new Error(
      "service child cleanup identity lost: lifecycle channels were not created",
    );
    cleanup.completion.reject(error);
    throw error;
  }
  const stopOnOutputFailure =
    params.stdoutConsumption === "awaited"
      ? () => requestedSignal !== "SIGKILL" && kill("SIGKILL")
      : undefined;
  const events = createProcessAdapterEvents();
  const outputFailure = (stream: "stdout" | "stderr", error: Error) => {
    resultError ??= error;
    events.emitError(error, stream);
    settleWait();
  };
  const stdoutRelay = createOutputRelay(
    child.stdout ?? undefined,
    false,
    stopOnOutputFailure,
    (error) => outputFailure("stdout", error),
  );
  const stderrRelay = createOutputRelay(
    child.stderr ?? undefined,
    Boolean(params.stderrDestination),
    undefined,
    (error) => outputFailure("stderr", error),
  );
  const unpipeStderr =
    child.stderr && params.stderrDestination
      ? pipeProcessOutput(child.stderr, params.stderrDestination, (error) =>
          events.emitError(error, "stderr"),
        )
      : undefined;
  child.stdin?.on("error", (error) => events.emitError(error, "stdin"));

  let state: AuthorityState = "starting";
  let commandPid: number | undefined;
  let anchorPid: number | undefined;
  let outboundSequence = 0;
  let inboundSequence = 0;
  let rootResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let resultError: Error | undefined;
  let closingReceipt = false;
  let controlError: Error | undefined;
  let childError: Error | undefined;
  let childDisconnected = false;
  let childExited = false;
  const relayExit = createDeferredCore();
  const lineageEnd = createDeferredCore();
  let requestedSignal: "SIGTERM" | "SIGKILL" | undefined;
  let waitError: Error | undefined;
  const startup = createDeferredCore();
  const resultCompletion = createDeferredCore<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>();
  // Failures can arrive before either public wait is requested.
  void startup.promise.catch(() => {});
  const constructionAbort = createDeferredCore<never>();
  void constructionAbort.promise.catch(() => {});
  let startupErrorAckDelivery: Promise<void> | undefined;
  let completionSettled = false;
  void Promise.allSettled([resultCompletion.promise, cleanup.outcome]).then(() => {
    completionSettled = true;
    cleanupDeadline.clear();
  });

  const settleWait = () => {
    retirement.reconcile();
    // Authority loss cannot erase an already observed root result. Output must
    // still drain, while the independent extinction join keeps the failure.
    const error = resultError ?? (rootResult ? undefined : waitError);
    if (error) {
      resultCompletion.reject(error);
      return;
    }
    if (!rootResult || !stdoutRelay.ended || !stderrRelay.ended) {
      return;
    }
    if (requestedSignal && state !== "closed" && state !== "identity-lost") {
      return;
    }
    resultCompletion.resolve(rootResult);
  };

  // Root result and output EOF cross different channels. Decoder flush listeners were
  // registered first, so settlement observes both final text tails before disposal.
  child.stdout?.once("end", settleWait);
  child.stdout?.once("close", settleWait);
  child.stderr?.once("end", settleWait);
  child.stderr?.once("close", settleWait);

  const loseIdentity = (message: string, options?: ErrorOptions) => {
    if (state === "closed" || state === "identity-lost") {
      return;
    }
    state = "identity-lost";
    waitError = new Error(`service child cleanup identity lost: ${message}`, options);
    try {
      events.emitError(waitError, "process");
    } catch (error) {
      // Observer failure cannot interrupt the authoritative cleanup settlement.
      waitError = toErrorObject(error, "service child cleanup error observer failed");
    }
    if (!commandPid) {
      startup.reject(waitError);
    }
    settleWait();
    cleanup.completion.reject(waitError);
    if (!params.ownedWorker) {
      lineage?.destroy();
    }
    // Release a forced relay's receipt hold without erasing the failed cleanup outcome.
    if (!useWindowsJobAnchor && child.connected) {
      child.disconnect();
    }
  };

  const expireCleanup = () => {
    if (completionSettled) {
      return;
    }
    const pending = {
      closingReceipt: !closingReceipt,
      controlClose: !control?.closed,
      relayExit: !childExited,
      lineageEof: !lineage?.readableEnded,
      extinctionUnconfirmed: state !== "closed",
      stdoutEnd: !stdoutRelay.ended,
      stderrEnd: !stderrRelay.ended,
    };
    const message =
      "service child cleanup did not complete before its hard deadline; pending: " +
      JSON.stringify(pending);
    const error = new Error(message, {
      cause: retirement.diagnostics(),
    });
    // Extinction may already be confirmed while an output pipe remains open.
    // Reject pending results before destroy can turn that missing tail into success.
    resultError ??= error;
    startup.reject(error);
    resultCompletion.reject(error);
    cleanup.completion.reject(error);
    try {
      loseIdentity(message);
    } finally {
      control?.destroy();
      if (!params.ownedWorker) {
        lineage?.destroy();
      }
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  };
  const cleanupDeadline = createServiceChildCleanupDeadline({
    enabled: () => !useWindowsJobAnchor && !completionSettled,
    expire: expireCleanup,
    force: () => kill("SIGKILL"),
  });

  const sendChildMessage = (
    message: ServiceChildStart | ServiceChildControlMessage,
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!child.connected) {
        reject(new Error("service child lifecycle IPC is closed"));
        return;
      }
      child.send(message, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });

  const sendControlMessage = (message: ServiceChildControlMessage): Promise<void> => {
    if (useWindowsJobAnchor) {
      return sendChildMessage(message);
    }
    return new Promise((resolve, reject) => {
      if (!control || control.destroyed) {
        reject(new Error("service child control pipe is closed"));
        return;
      }
      control.write(encodeServiceChildMessage(message), "utf8", (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  };

  const retirement = createServiceChildRelayRetirement({
    child,
    generation,
    nextSequence: () => ++outboundSequence,
    startedAt: () => cleanupDeadline.startedAt!,
    anchorGone: () => {
      if (anchorPid === undefined) {
        return false;
      }
      try {
        process.kill(-anchorPid, 0);
        return false;
      } catch (error) {
        return extractErrorCode(error) === "ESRCH";
      }
    },
    canRetire: () =>
      state === "closing" &&
      control?.closed === true &&
      lineage?.readableEnded === true &&
      stdoutRelay.ended &&
      stderrRelay.ended &&
      performance.now() < cleanupDeadline.at!,
  });

  lineage?.once("end", () => {
    lineageEnd.resolve();
    retirement.reconcile();
    if (state !== "starting" && state !== "active") {
      return;
    }
    void sendControlMessage({
      type: "lineage-closed",
      generation,
      sequence: ++outboundSequence,
    }).catch((error: unknown) => {
      if (state === "starting" || state === "active") {
        loseIdentity(toErrorObject(error, "lineage notification failed").message);
      }
    });
  });
  lineage?.once("error", (error) => loseIdentity("lineage observation failed", { cause: error }));
  lineage?.once("close", () => {
    if (!lineage.readableEnded) {
      loseIdentity("lineage reader closed before EOF");
    }
  });
  lineage?.resume();

  const onConstructionAbort = () => {
    child.kill("SIGKILL");
    // The anchor may still be cleaning its group after relay loss. Keep that
    // uncertainty observable; a later receipt cannot prove this aborted startup extinct.
    loseIdentity("construction aborted");
    constructionAbort.reject(waitError ?? new Error("service child construction aborted"));
  };
  const removeConstructionAbortListener = () => {
    params.abortSignal?.removeEventListener("abort", onConstructionAbort);
  };

  const finishAuthorityClose = (missingReceiptError: string) => {
    if (state === "closed" || state === "identity-lost") {
      return;
    }
    if (!closingReceipt) {
      loseIdentity(missingReceiptError);
      return;
    }
    state = "closed";
    if (!rootResult && !resultError && !waitError) {
      rootResult = { code: null, signal: requestedSignal ?? null };
    }
    settleWait();
    cleanup.completion.resolve();
    if (retirement.result) {
      cleanupDeadline.budget?.warn(
        "service child relay required forced retirement; cleanup completed",
      );
    }
  };

  const finishPosixAuthority = async () => {
    const missingReceiptError =
      childError?.message ??
      controlError?.message ??
      "anchor channel closed without a matching closing receipt";
    retirement.reconcile();
    if (state === "closed" || state === "identity-lost") {
      return;
    }
    if (!closingReceipt || !anchorPid) {
      loseIdentity(missingReceiptError);
      return;
    }
    // Closure requires lineage EOF outside the group as well as kernel group
    // disappearance; an escaped writer survives the anchor's group-wide KILL.
    cleanupDeadline.begin();
    if (!lineage?.readableEnded) {
      await Promise.race([lineageEnd.promise, cleanup.completion.promise]);
    }
    if (state !== "closing") {
      return;
    }
    for (;;) {
      retirement.reconcile();
      if (childExited) {
        try {
          // Observation only: signalling a retired numeric PGID could hit a reused group.
          process.kill(-anchorPid, 0);
        } catch (cause) {
          const code = extractErrorCode(cause);
          if (code === "ESRCH") {
            finishAuthorityClose(missingReceiptError);
            return;
          }
          if (code !== "EPERM") {
            loseIdentity("owned process group disappearance could not be confirmed", { cause });
            return;
          }
          // EPERM proves presence, not lost ownership. Keep observing within the same deadline.
        }
      }
      const remainingMs = cleanupDeadline.at! - performance.now();
      if (remainingMs <= 0 && childExited) {
        expireCleanup();
        return;
      }
      // After the budget expires, the deadline owner's I/O poll can still deliver queued exit.
      await Promise.race([
        ...(remainingMs > 0 ? [delay(Math.min(100, remainingMs))] : []),
        ...(!childExited ? [relayExit.promise] : []),
        cleanup.completion.promise,
      ]);
      if (state !== "closing") {
        return;
      }
    }
  };

  const handleAnchorMessage = (message: ServiceChildAnchorMessage) => {
    if (message.generation !== generation || message.sequence <= inboundSequence) {
      loseIdentity("stale anchor generation or sequence");
      return;
    }
    inboundSequence = message.sequence;
    if (message.type === "ready" && state === "starting") {
      // Ready is not construction-complete: secret delivery can still be
      // blocked. Keep abort protection until the adapter returns.
      commandPid = message.commandPid;
      anchorPid = message.anchorPid;
      state = "active";
      startup.resolve();
    } else if (message.type === "root-result") {
      stdin?.destroy?.();
      if (!resultError && !rootResult) {
        rootResult = { code: message.code, signal: message.signal };
        events.emitExit(message.code, message.signal);
      }
      settleWait();
    } else if (message.type === "stdin-closed") {
      stdin?.destroy?.();
    } else if (message.type === "worker-message" && params.ownedWorker) {
      try {
        params.onWorkerMessage?.(message.message);
      } catch {
        // Diagnostic consumers cannot change child supervision.
      }
    } else if (message.type === "result-error") {
      resultError ??= new Error(`service child result unavailable: ${message.error}`);
      settleWait();
    } else if (message.type === "output") {
      if (!(message.stream === "stdout" ? stdoutRelay : stderrRelay).push(message.chunk)) {
        resultError ??= new Error(
          `service child ${message.stream} exceeded its pre-subscription buffer`,
        );
        settleWait();
      }
    } else if (message.type === "output-end") {
      (message.stream === "stdout" ? stdoutRelay : stderrRelay).end();
      settleWait();
    } else if (message.type === "closing") {
      if (state === "closed" || state === "identity-lost") {
        return;
      }
      closingReceipt = true;
      state = "closing";
      cleanupDeadline.begin();
      retirement.reconcile();
      if (control) {
        // Retire cancellation before acknowledging this exact POSIX receipt.
        // The ACK releases the sender, not the independent native extinction join.
        outboundSequence += 1;
        void sendControlMessage({
          type: "closing-ack",
          generation,
          sequence: outboundSequence,
          closingSequence: message.sequence,
        }).catch((error: unknown) => {
          controlError ??= toErrorObject(error, "closing acknowledgement failed");
        });
      }
    } else if (message.type === "startup-error") {
      if (useWindowsJobAnchor) {
        startup.reject(new Error(message.error));
      } else {
        loseIdentity(message.error);
      }
      outboundSequence += 1;
      startupErrorAckDelivery = sendControlMessage({
        type: "startup-error-ack",
        generation,
        sequence: outboundSequence,
      });
      void startupErrorAckDelivery.catch((error: unknown) =>
        loseIdentity(toErrorObject(error, "startup error acknowledgement failed").message),
      );
    }
  };

  if (control) {
    readServiceChildControl(
      control,
      (line) => {
        try {
          const message = readChildMessage(JSON.parse(line));
          if (!("sequence" in message) || message.type === "retirement") {
            throw new Error("invalid anchor message");
          }
          handleAnchorMessage(message);
        } catch {
          loseIdentity("invalid anchor message");
        }
      },
      () => {
        loseIdentity("control pipe pending line exceeded cap");
        child.kill("SIGKILL");
      },
    );
    const finishControl = cleanup.bindAuthorityClose(finishPosixAuthority, (reason) => {
      // Unexpected finalization failures belong to the same cleanup outcome.
      state = "identity-lost";
      waitError = toErrorObject(reason, "service child authority close failed");
      startup.reject(reason);
      settleWait();
      cleanup.completion.reject(reason);
      if (!params.ownedWorker) {
        lineage?.destroy();
      }
      if (child.connected) {
        child.disconnect();
      }
    });
    // The final socket close callback can follow the queued expiry; start the join at EOF.
    control.once("end", finishControl);
    control.once("close", () => {
      if (!control.readableEnded) {
        finishControl();
      }
    });
    control.on("error", (error) => {
      controlError ??= error;
    });
  }

  child.on("message", (raw: unknown) => {
    const message = readChildMessage(raw);
    if (!message || typeof message !== "object") {
      if (useWindowsJobAnchor) {
        loseIdentity("invalid anchor message");
      }
      return;
    }
    if (useWindowsJobAnchor) {
      if (!("sequence" in message) || message.type === "retirement") {
        loseIdentity("invalid anchor message");
        return;
      }
      handleAnchorMessage(message);
      return;
    }
    if (message.generation !== generation) {
      return;
    }
    if (message.type === "relay-error") {
      loseIdentity(message.error);
    } else if (message.type === "retirement") {
      retirement.receive(message);
    }
  });
  child.once("error", (error) => {
    // The direct control pipe may still contain the anchor's authoritative closing receipt.
    childError ??= error;
    events.emitError(error, "process");
  });
  const finishWindowsAuthority = () => {
    if (!useWindowsJobAnchor || !childDisconnected || !childExited) {
      return;
    }
    finishAuthorityClose(
      childError?.message ?? "Windows service child anchor exited without a closing receipt",
    );
  };
  child.once("disconnect", () => {
    childDisconnected = true;
    finishWindowsAuthority();
  });
  child.once("exit", (code, signal) => {
    childExited = true;
    retirement.observeExit(code, signal);
    relayExit.resolve();
    removeConstructionAbortListener();
    if (useWindowsJobAnchor) {
      finishWindowsAuthority();
    }
  });

  const start: ServiceChildStart = {
    type: "start",
    generation,
    command: params.command,
    args: params.args,
    argv0: params.argv0,
    cwd: params.cwd,
    env: params.env ? toStringEnv(params.env) : undefined,
    stdinMode: params.stdinMode,
    secretFd: params.secretInput?.fd,
    controlFd,
    ...preparation.ownership,
    ...(control ? { acknowledgeClosing: true as const } : {}),
    windowsShellCommand: params.windowsShellCommand,
  };
  const stdin = createManagedChildStdin(child.stdin);
  params.abortSignal?.addEventListener("abort", onConstructionAbort, { once: true });
  const ready = (async () => {
    using delivery = preparation.transferSecretInput();
    try {
      params.assertCurrent?.();
      if (params.abortSignal?.aborted) {
        onConstructionAbort();
      }
      params.beforeSpawn?.();
      await Promise.race([sendChildMessage(start), constructionAbort.promise]);
      params.assertCurrent?.();
      const [startupResult, secretDeliveryResult] = await Promise.allSettled([
        startup.promise,
        delivery?.deliverTo(child, { abortSignal: params.abortSignal }),
      ]);
      const startupError = startupResult.status === "rejected" ? startupResult.reason : undefined;
      const secretDeliveryError =
        secretDeliveryResult.status === "rejected" ? secretDeliveryResult.reason : undefined;
      // Preserve admission failure over the secret pipe it closes as a consequence.
      if (startupError !== undefined || secretDeliveryError !== undefined) {
        if (useWindowsJobAnchor && startupError !== undefined) {
          await startupErrorAckDelivery;
          await cleanup.completion.promise;
        }
        throw startupError ?? secretDeliveryError;
      }
      if (params.abortSignal?.aborted || waitError) {
        throw waitError ?? new Error("service child construction aborted");
      }
      params.assertCurrent?.();
      if (params.input !== undefined) {
        stdin?.write(params.input);
        stdin?.end();
      } else if (params.stdinMode === "pipe-closed") {
        stdin?.end();
      }
    } catch (error) {
      void stdoutRelay.drain();
      unpipeStderr?.();
      void stderrRelay.drain();
      child.kill("SIGKILL");
      throw error;
    } finally {
      removeConstructionAbortListener();
    }
  })();
  void ready.catch(() => {});

  function kill(signal: NodeJS.Signals = "SIGKILL") {
    const normalized = signal === "SIGTERM" ? "SIGTERM" : "SIGKILL";
    cleanupDeadline.cancel(normalized);
    if (normalized === "SIGKILL") {
      retirement.request();
    }
    // A closing receipt retires group cancellation, not the retained relay handle.
    // Remember force requests until closure events permit anchor reaping and relay retirement.
    if (state !== "active") {
      return;
    }
    requestedSignal = normalized;
    outboundSequence += 1;
    // The host never converts the diagnostic command PID into group authority.
    void sendControlMessage({
      type: "cancel",
      generation,
      sequence: outboundSequence,
      signal: normalized,
    }).catch((error: unknown) => {
      // Delivery can fail after the anchor has already sent its closing receipt.
      if (state === "active") {
        loseIdentity(toErrorObject(error, "service child cancellation failed").message);
      }
    });
  }

  let startGate: Promise<void> | undefined;
  let startGateClosed = false;
  const openStartGate = params.ownedWorker
    ? () => {
        if (startGateClosed || state !== "active" || requestedSignal) {
          return Promise.reject(new Error("worker lifecycle closed before startup"));
        }
        return (startGate ??= sendControlMessage({
          type: "worker-start",
          generation,
          sequence: ++outboundSequence,
        }));
      }
    : undefined;

  const adapter: ServiceChildRelayAdapter = {
    // The durable worker receipt binds the group owner, which survives application loss.
    get pid() {
      return params.ownedWorker ? anchorPid : commandPid;
    },
    stdin,
    oomScoreWrapperSelected: params.oomScoreWrapperSelected,
    supportsRawOutput: !useWindowsJobAnchor,
    onStdout: stdoutRelay.subscribe,
    ...(stdoutRelay.consume ? { consumeStdout: stdoutRelay.consume } : {}),
    onStderr: stderrRelay.subscribe,
    onExit: events.onExit,
    onError: events.onError,
    wait: async () => {
      // A caller may intentionally ignore one stream; wait still owns draining it.
      const output = stdoutRelay.drain();
      void stderrRelay.drain();
      settleWait();
      return output
        ? await joinProcessCompletionAndOutput(resultCompletion.promise, output)
        : await resultCompletion.promise;
    },
    waitForExtinction: () => cleanup.promise,
    confirmExtinction: () =>
      state === "closed" ||
      Boolean(
        !useWindowsJobAnchor &&
        anchorPid &&
        childExited &&
        lineage?.readableEnded &&
        stdoutRelay.ended &&
        stderrRelay.ended &&
        isOwnedProcessGroupGone(anchorPid),
      ),
    get cleanupResult() {
      return state === "closed" ? retirement.result : undefined;
    },
    kill,
    openStartGate,
    closeStartGate: params.ownedWorker
      ? () => {
          startGateClosed = true;
          void sendControlMessage({
            type: "worker-close",
            generation,
            sequence: ++outboundSequence,
          }).catch((error: unknown) => {
            if (state === "active") {
              loseIdentity("worker startup channel could not be closed", { cause: error });
            }
          });
        }
      : undefined,
    dispose: () => {
      if (unpipeStderr) {
        unpipeStderr();
        child.stderr?.destroy();
      }
      stdoutRelay.clear();
      stderrRelay.clear();
      events.clear();
    },
  };
  return { adapter, ready };
}
