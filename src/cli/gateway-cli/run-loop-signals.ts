import { performance } from "node:perf_hooks";
import { formatErrorMessage } from "../../infra/errors.js";
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
  isForcedExitStarted: () => boolean;
  isForegroundUpdateClosed: () => boolean;
  isRuntimeResetPending: () => boolean;
  isShuttingDown: () => boolean;
  getExternalRestartOwner: () => GatewaySuspendHandoffOwner | undefined;
  getTerminalHostedStop: () => ReturnType<typeof createGatewayHostLifecycle> | undefined;
  updateSuccessor: Pick<GatewayUpdateSuccessor, "stop" | "stopRequested">;
  forceExit: (reason: string) => Promise<void>;
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
  const drainRestartSignals = async () => {
    for (;;) {
      if (!signalSettlement) {
        break;
      }
      await signalSettlement;
    }
  };
  const settleRestartSignals = async () => {
    for (;;) {
      if (!signalSettlement) {
        break;
      }
      await signalSettlement;
    }
    // Captured signals wait for close to settle before reacquiring this file.
    sealSignalStore();
  };
  const enqueueSignal = (
    readIntent: boolean,
    handle: (intent: GatewayRestartIntent | null, acceptedAtMs: number) => void,
    failed: (error: unknown, acceptedAtMs: number) => void,
  ) => {
    const iteration = params.getIteration();
    const acceptedAtMs = performance.now();
    signalAdmission = beginGatewayRestartSignalAdmission() ?? signalAdmission;
    const isCurrent = () =>
      signalsActive && !params.isForcedExitStarted() && params.getIteration() === iteration;
    const assertCurrent = () => {
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
          )
        : undefined;
    } catch (error) {
      preparationFailure = { error };
    }
    const deadline = consumeIntent
      ? setTimeout(
          () => {
            void params.forceExit("gateway.restart_signal_settlement_timeout");
          },
          Math.max(0, params.timeoutMs - (performance.now() - acceptedAtMs)),
        )
      : undefined;
    deadline?.unref?.();
    const processSignal = async () => {
      try {
        if (!isCurrent()) {
          return;
        }
        if (preparationFailure) {
          throw preparationFailure.error;
        }
        for (;;) {
          if (!consumeIntent || signalStoreOpen) {
            break;
          }
          await signalStoreOpening;
          if (!isCurrent()) {
            return;
          }
        }
        const restartIntent = consumeIntent ? await consumeIntent() : null;
        if (isCurrent()) {
          handle(restartIntent, acceptedAtMs);
        }
      } catch (error) {
        if (isCurrent()) {
          failed(error, acceptedAtMs);
        }
      } finally {
        clearTimeout(deadline);
      }
    };
    const settled = signalSettlement ? signalSettlement.then(processSignal) : processSignal();
    signalSettlement = settled;
    void settled.then(() => {
      if (signalSettlement === settled) {
        signalSettlement = undefined;
        signalAdmission?.rollback();
        signalAdmission = null;
      }
    });
  };
  const onSigterm = () => {
    observeSignal("SIGTERM");
    gatewayLog.debug("signal SIGTERM received");
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
    if (!params.isShuttingDown()) {
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
        gatewayLog.error(`failed to handle SIGTERM: ${String(err)}`);
        request("stop", "SIGTERM", undefined, undefined, undefined, {
          acceptedAtMs,
          suspendHandoff,
        });
      },
    );
  };
  const onSigint = () => {
    observeSignal("SIGINT");
    gatewayLog.debug("signal SIGINT received");
    if (params.isForcedExitStarted()) {
      request("stop", "SIGINT");
      return;
    }
    enqueueSignal(
      false,
      (_intent, acceptedAtMs) =>
        request("stop", "SIGINT", undefined, undefined, undefined, { acceptedAtMs }),
      (error) => gatewayLog.error(`failed to handle SIGINT: ${formatErrorMessage(error)}`),
    );
  };
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
  const onRestartSignal = () => {
    observeSignal("SIGUSR2");
    gatewayLog.debug("signal SIGUSR2 received");
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
      enqueueSignal(
        true,
        (durableIntent, acceptedAtMs) => {
          const restartIntent = durableIntent
            ? { ...durableIntent, ...(localIntent?.successorOwner ? localIntent : {}) }
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
        },
        (error) => restartSignalFailed(error, false),
      );
    } catch (err) {
      restartSignalFailed(err);
    }
  };

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
    drain: drainRestartSignals,
    settle: settleRestartSignals,
    retire,
    close() {
      retire();
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGUSR2", onRestartSignal);
    },
  };
}
