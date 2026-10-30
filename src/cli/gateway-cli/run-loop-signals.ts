import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { raceWithTimeout } from "../../../packages/retry/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isGatewayStateProcessOwnerRetiredError } from "../../infra/gateway-state-owner-errors.js";
import {
  consumeGatewaySuspendHandoff,
  type GatewaySuspendHandoffOwner,
} from "../../infra/gateway-suspend-coordinator.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { beginGatewayRestartSignalAdmission } from "../../process/gateway-work-admission.js";
import type { createGatewayHostLifecycle } from "./host-lifecycle.js";
import { createGatewaySignalObserver } from "./run-loop-exit.js";
import type {
  GatewayRunSignalAction,
  GatewayRunSignalContext,
  GatewayRunSignalRequest,
} from "./run-loop-request.js";
import type { GatewayUpdateSuccessor } from "./update-successor.js";

/** Owns signal capture, ordered consumption and settlement for one run loop. */
export function createGatewayRunSignals(params: {
  lifecycle: Pick<
    typeof import("./lifecycle.runtime.js"),
    | "prepareGatewayRestartIntentConsumption"
    | "consumeGatewayRestartAuthorization"
    | "consumeGatewayRestartIntent"
    | "peekGatewayRestartReason"
    | "markGatewayRestartHandled"
    | "rollbackGatewayRestartSignalAdmission"
    | "isGatewayRestartExternallyAllowed"
    | "abortPendingChannelReloads"
    | "scheduleGatewayRestart"
  >;
  logger: Pick<SubsystemLogger, "debug" | "info" | "warn" | "error">;
  timeoutMs: number;
  getIteration: () => object;
  isTerminal: () => boolean;
  isForcedExitStarted: () => boolean;
  isForegroundUpdateClosed: () => boolean;
  isRuntimeResetPending: () => boolean;
  isShuttingDown: () => boolean;
  getExternalRestartOwner: () => GatewaySuspendHandoffOwner | undefined;
  getTerminalHostedStop: () => ReturnType<typeof createGatewayHostLifecycle> | undefined;
  updateSuccessor: Pick<GatewayUpdateSuccessor, "stop" | "stopRequested">;
  request: (
    action: GatewayRunSignalAction,
    signal: GatewayRunSignalRequest["signal"],
    restartReason?: string,
    restartIntent?: GatewayRestartIntent,
    hostedStop?: ReturnType<typeof createGatewayHostLifecycle>,
    context?: GatewayRunSignalContext,
  ) => void;
}) {
  const { lifecycle: eagerLifecycleRuntime, logger: gatewayLog, request, updateSuccessor } = params;
  const observeSignal = createGatewaySignalObserver(gatewayLog);
  let signalSettlement: Promise<void> | undefined;
  let signalAdmission: ReturnType<typeof beginGatewayRestartSignalAdmission> = null;
  let signalStoreOpen = true;
  let signalStoreOpening: Promise<void> | undefined;
  let reopenSignalStore: (() => void) | undefined;
  let signalsActive = true;
  const sealSignalStore = () => {
    signalStoreOpen = false;
    signalStoreOpening ??= new Promise<void>((resolve) => {
      reopenSignalStore = resolve;
    });
  };
  const openSignalStore = () => {
    signalStoreOpen = true;
    reopenSignalStore?.();
    reopenSignalStore = undefined;
    signalStoreOpening = undefined;
  };
  const drainRestartSignals = async (sealStore = false) => {
    for (;;) {
      if (!signalSettlement) {
        break;
      }
      await signalSettlement;
    }
    if (sealStore) {
      // Captured signals wait for close to settle before reacquiring this file.
      sealSignalStore();
    }
  };
  const enqueueSignal = (
    readIntent: boolean,
    handle: (intent: GatewayRestartIntent | null, acceptedAtMs: number) => void,
    failed: (error: unknown, acceptedAtMs: number) => void,
  ) => {
    const iteration = params.getIteration();
    const acceptedAtMs = performance.now();
    const controller = new AbortController();
    let waitingFor = "earlier signal settlement";
    signalAdmission = beginGatewayRestartSignalAdmission() ?? signalAdmission;
    const isCurrent = () =>
      signalsActive &&
      !params.isTerminal() &&
      !params.isForcedExitStarted() &&
      params.getIteration() === iteration;
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (!isCurrent()) {
        throw new Error("Gateway signal belongs to a retired lifecycle iteration");
      }
    };
    let consumeIntent: (() => Promise<GatewayRestartIntent | null>) | undefined;
    let preparationFailure: { error: unknown } | undefined;
    try {
      consumeIntent = readIntent
        ? eagerLifecycleRuntime.prepareGatewayRestartIntentConsumption(
            undefined,
            undefined,
            assertCurrent,
            controller.signal,
          )
        : undefined;
    } catch (error) {
      preparationFailure = { error };
    }
    const processSignal = async () => {
      if (!isCurrent() || controller.signal.aborted) {
        return;
      }
      if (preparationFailure) {
        throw preparationFailure.error;
      }
      waitingFor = "restart-intent store to reopen";
      for (;;) {
        if (!consumeIntent || signalStoreOpen) {
          break;
        }
        await signalStoreOpening;
        assertCurrent();
      }
      waitingFor = "restart-intent consumption";
      const restartIntent = consumeIntent ? await consumeIntent() : null;
      assertCurrent();
      handle(restartIntent, acceptedAtMs);
    };
    // Intent metadata must not spend the shutdown budget or prevent resume markers.
    // Native writes still settle with their owner; abort refuses any late consumption.
    const timeoutMs = Math.min(1_000, params.timeoutMs);
    const settled = raceWithTimeout(
      () => (signalSettlement ? signalSettlement.then(processSignal) : processSignal()),
      Math.max(0, timeoutMs - (performance.now() - acceptedAtMs)),
      () => {
        const error = new Error(
          `restart signal settlement exceeded ${timeoutMs}ms waiting for ${waitingFor}`,
        );
        controller.abort(error);
        throw error;
      },
      { ref: false },
    ).catch((error: unknown) => {
      if (isCurrent()) {
        failed(error, acceptedAtMs);
      }
    });
    signalSettlement = settled;
    void settled.then(() => {
      if (signalSettlement === settled) {
        signalSettlement = undefined;
        signalAdmission?.rollback();
        signalAdmission = null;
      }
    });
  };
  // In-process emitters can retire their async scope during shutdown. The loop
  // owns signal consumption and restart, including the next state-lock acquisition.
  const onSigterm = AsyncLocalStorage.bind(() => {
    if (!signalsActive || params.isTerminal()) {
      return;
    }
    observeSignal("SIGTERM");
    const terminalHostedStop = params.getTerminalHostedStop();
    if (terminalHostedStop) {
      // Kernel cleanup is already joined. A native stop signal belongs to this
      // terminal continuation, not to restart-intent storage in the closed kernel.
      terminalHostedStop.notifyStopSignal();
      return;
    }
    if (params.isForegroundUpdateClosed()) {
      updateSuccessor.stop("SIGTERM");
      return;
    }
    if (params.isForcedExitStarted()) {
      request("stop", "SIGTERM");
      return;
    }
    // Transfer this in-memory authority before even the reversible signal fence.
    let suspendHandoff: ReturnType<typeof consumeGatewaySuspendHandoff> | undefined;
    const duringShutdown = params.isShuttingDown();
    if (!duringShutdown) {
      try {
        suspendHandoff = consumeGatewaySuspendHandoff(params.getExternalRestartOwner());
      } catch (error) {
        suspendHandoff = { ok: false, error: formatErrorMessage(error) };
      }
    }
    enqueueSignal(
      true,
      (restartIntent, acceptedAtMs) => {
        // SIGTERM hands replacement to the caller (e.g. systemctl restart).
        request(
          restartIntent ? "external-restart" : "stop",
          "SIGTERM",
          restartIntent?.reason,
          restartIntent ?? undefined,
          undefined,
          { acceptedAtMs, suspendHandoff },
        );
      },
      (err, acceptedAtMs) => {
        if (duringShutdown && isGatewayStateProcessOwnerRetiredError(err)) {
          // A closing iteration (e.g. an in-process restart) already released
          // state; no restart intent can be read, and stopping is the outcome.
          gatewayLog.info(
            "received SIGTERM after shutdown released Gateway state; stopping without a restart intent",
          );
        } else {
          gatewayLog.error(`failed to handle SIGTERM: ${String(err)}`);
        }
        request("stop", "SIGTERM", undefined, undefined, undefined, {
          acceptedAtMs,
          suspendHandoff,
        });
      },
    );
  });
  const onSigint = AsyncLocalStorage.bind(() => {
    if (!signalsActive || params.isTerminal()) {
      return;
    }
    observeSignal("SIGINT");
    if (params.isForcedExitStarted()) {
      request("stop", "SIGINT");
      return;
    }
    enqueueSignal(
      false,
      (_intent, acceptedAtMs) =>
        request("stop", "SIGINT", undefined, undefined, undefined, { acceptedAtMs }),
      (error, acceptedAtMs) => {
        gatewayLog.error(`failed to handle SIGINT: ${formatErrorMessage(error)}`);
        request("stop", "SIGINT", undefined, undefined, undefined, { acceptedAtMs });
      },
    );
  });
  const restartSignalFailed = (err: unknown, releaseToken = true) => {
    gatewayLog.error(`SIGUSR2 handler failed: ${formatErrorMessage(err)}`);
    if (!releaseToken) {
      return;
    }
    try {
      eagerLifecycleRuntime.markGatewayRestartHandled();
    } catch {
      // Token recovery must not prevent admission recovery.
    }
    if (!updateSuccessor.stopRequested) {
      try {
        eagerLifecycleRuntime.rollbackGatewayRestartSignalAdmission();
      } catch {
        // Keep admission recovery independent from restart-token recovery.
      }
    }
  };
  const onRestartSignal = AsyncLocalStorage.bind(() => {
    if (!signalsActive || params.isTerminal()) {
      return;
    }
    observeSignal("SIGUSR2");
    if (params.isForegroundUpdateClosed()) {
      return;
    }
    try {
      // Capture this emitted cycle before yielding; a later signal owns a later
      // token and must not be consumed by this continuation.
      const authorized = eagerLifecycleRuntime.consumeGatewayRestartAuthorization();
      const localIntent = authorized ? eagerLifecycleRuntime.consumeGatewayRestartIntent() : null;
      const reason = eagerLifecycleRuntime.peekGatewayRestartReason();
      const deferRestartDrain = params.isRuntimeResetPending();
      eagerLifecycleRuntime.markGatewayRestartHandled();
      const handleRestart = (durableIntent: GatewayRestartIntent | null, acceptedAtMs: number) => {
        const restartIntent = durableIntent
          ? {
              ...durableIntent,
              ...(localIntent?.successorOwner || localIntent?.requireFreshProcess
                ? localIntent
                : {}),
            }
          : localIntent;
        if (!durableIntent && !authorized) {
          if (!eagerLifecycleRuntime.isGatewayRestartExternallyAllowed()) {
            gatewayLog.warn("SIGUSR2 restart ignored (not authorized; commands.restart=false).");
            gatewayLog.warn(
              "An unauthorized SIGUSR2 restart signal was received and ignored. " +
                "If a pending gateway restart needs to be applied, run `openclaw gateway restart` " +
                "or restart the gateway through your service manager.",
            );
            return;
          }
          if (params.isShuttingDown()) {
            gatewayLog.info("received SIGUSR2 during shutdown; ignoring");
            return;
          }
          eagerLifecycleRuntime.abortPendingChannelReloads();
          eagerLifecycleRuntime.scheduleGatewayRestart({ delayMs: 0, reason: "SIGUSR2" });
          return;
        }
        eagerLifecycleRuntime.abortPendingChannelReloads();
        request(
          "restart",
          "SIGUSR2",
          restartIntent?.reason ?? (durableIntent ? "gateway.restart" : reason),
          restartIntent ?? undefined,
          undefined,
          { acceptedAtMs, deferRestartDrain },
        );
      };
      enqueueSignal(true, handleRestart, (error, acceptedAtMs) => {
        if (!authorized) {
          restartSignalFailed(error, false);
          return;
        }
        gatewayLog.warn(
          `Restart intent could not be read; continuing the authorized local restart: ${formatErrorMessage(error)}`,
        );
        handleRestart(null, acceptedAtMs);
      });
    } catch (err) {
      restartSignalFailed(err);
    }
  });

  process.on("SIGTERM", onSigterm);
  process.on("SIGINT", onSigint);
  // SIGUSR1 belongs to Node's on-demand inspector; never register a listener for it.
  process.on("SIGUSR2", onRestartSignal);
  const retire = () => {
    signalsActive = false;
    openSignalStore();
  };
  return {
    get pending() {
      return signalSettlement;
    },
    get active() {
      return signalsActive;
    },
    sealStore: sealSignalStore,
    openStore: openSignalStore,
    drain: () => drainRestartSignals(),
    settle: () => drainRestartSignals(true),
    retire,
    close() {
      retire();
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGUSR2", onRestartSignal);
    },
  };
}
