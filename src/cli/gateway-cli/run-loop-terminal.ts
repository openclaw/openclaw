import { formatErrorMessage } from "../../infra/errors.js";
import type { GatewayBootLifecycleCompletion } from "../../infra/gateway-boot-lifecycle.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import type { createGatewayHostLifecycle } from "./host-lifecycle.js";
import { sameManagedUpdateOwner, type GatewayRunSignalRequest } from "./run-loop-request.js";
import type { createGatewayRestartRuntimePreparation } from "./run-loop-runtime-preparation.js";
import type { createGatewayRunSignals } from "./run-loop-signals.js";
import type { GatewayUpdateSuccessor } from "./update-successor.js";

type HostLifecycle = ReturnType<typeof createGatewayHostLifecycle>;
type UpdateOwner = GatewayRestartIntent["successorOwner"];
export type GatewayShutdownFailure = { step: string; error: unknown };

/** Terminal continuation shares the loop's live authority; it owns no copied request state. */
export function createGatewayRunTerminal(params: {
  runtime: Pick<
    typeof import("./lifecycle.runtime.js"),
    "claimManagedServiceUpdateHandoff" | "commitManagedServiceUpdateHandoff"
  >;
  logger: Pick<SubsystemLogger, "info" | "error">;
  updateSuccessor: GatewayUpdateSuccessor;
  restartRuntime: ReturnType<typeof createGatewayRestartRuntimePreparation>;
  getSignals: () => ReturnType<typeof createGatewayRunSignals>;
  getHost: () => HostLifecycle | undefined;
  getRequest: () => GatewayRunSignalRequest | null;
  isForcedExitStarted: () => boolean;
  isForegroundUpdateClosed: () => boolean;
  getTerminalHostedStop: () => HostLifecycle | undefined;
  setTerminalHostedStop: (owner: HostLifecycle | undefined) => void;
  setPendingRestartCompletion: (completion: GatewayBootLifecycleCompletion) => void;
  drainProcessResources: () => Promise<void>;
  finishLoop: (code: number) => void;
  completeBoot: (completion: GatewayBootLifecycleCompletion) => void;
  releaseLockIfHeld: () => Promise<void>;
  markRestartHandoffUnavailable: () => Promise<void>;
  reacquireAndResumeInProcessRestart: (owner?: UpdateOwner) => Promise<void>;
  forceExitAfterStabilityBundle: (
    reason: string,
    code?: number,
    failure?: GatewayShutdownFailure,
  ) => Promise<void>;
}) {
  const {
    runtime: eagerLifecycleRuntime,
    logger: gatewayLog,
    updateSuccessor,
    restartRuntime,
    finishLoop,
    completeBoot,
    releaseLockIfHeld,
    markRestartHandoffUnavailable,
    reacquireAndResumeInProcessRestart,
    forceExitAfterStabilityBundle,
  } = params;
  const getManagedUpdateOwner = () => params.getRequest()?.restartIntent?.successorOwner;
  const finishLoopAfterSignals = async (code: number) => {
    if (restartRuntime.pending) {
      await restartRuntime.release();
    }
    for (;;) {
      if (params.isForcedExitStarted() || !params.getSignals().pending) {
        break;
      }
      await params.getSignals().pending;
    }
    finishLoop(code);
  };
  const finishLoopAfterCleanup = async (
    code: number,
    initialOwner?: GatewayRestartIntent["successorOwner"],
    initialOutcome: "update" | "restore" = "update",
    hostStopOwner?: HostLifecycle,
  ): Promise<void> => {
    if (hostStopOwner && params.getHost() !== hostStopOwner) {
      return;
    }
    if (!params.isForcedExitStarted()) {
      await params.getSignals().drain();
    }
    if (restartRuntime.pending) {
      await restartRuntime.release();
    }
    let ownerToCommit = initialOwner;
    let commitOutcome = initialOutcome;
    await params.drainProcessResources();
    for (;;) {
      for (;;) {
        if (params.isForcedExitStarted() || !params.getSignals().pending) {
          break;
        }
        await params.getSignals().pending;
      }
      if (hostStopOwner && params.getHost() !== hostStopOwner) {
        return;
      }
      if (params.isForegroundUpdateClosed()) {
        await updateSuccessor.exit(code, finishLoopAfterSignals);
        return;
      }
      const owner = getManagedUpdateOwner();
      if (!owner) {
        if (!ownerToCommit) {
          if (updateSuccessor.capturedStop) {
            await updateSuccessor.exit(code, finishLoopAfterSignals);
          } else {
            finishLoop(code);
          }
        }
        return;
      }
      const committed =
        sameManagedUpdateOwner(owner, ownerToCommit) &&
        eagerLifecycleRuntime.claimManagedServiceUpdateHandoff(owner) &&
        (await eagerLifecycleRuntime.commitManagedServiceUpdateHandoff(owner, commitOutcome));
      for (;;) {
        if (params.isForcedExitStarted() || !params.getSignals().pending) {
          break;
        }
        await params.getSignals().pending;
      }
      if (
        committed &&
        sameManagedUpdateOwner(getManagedUpdateOwner(), owner) &&
        eagerLifecycleRuntime.claimManagedServiceUpdateHandoff(owner)
      ) {
        // Keep exact request ownership live through the synchronous terminal decision.
        finishLoop(code);
        return;
      }
      await markRestartHandoffUnavailable();
      const ownerToCancel = ownerToCommit ?? owner;
      const restoration = await updateSuccessor.cancelHandoff(getManagedUpdateOwner, ownerToCancel);
      if (!restoration) {
        await updateSuccessor.cancel();
        return;
      }
      if (restoration === "restart-after-exit") {
        ownerToCommit = ownerToCancel;
        commitOutcome = "restore";
        const currentRequest = params.getRequest();
        if (
          currentRequest &&
          !sameManagedUpdateOwner(currentRequest.restartIntent?.successorOwner, ownerToCancel)
        ) {
          currentRequest.restartIntent = {
            ...currentRequest.restartIntent,
            successorOwner: ownerToCancel,
          };
        }
        continue;
      }
      // Restoring the helper does not make a failed generation reusable.
      if (
        code === 0 &&
        !params.isForcedExitStarted() &&
        !updateSuccessor.committed &&
        initialOwner
      ) {
        return reacquireAndResumeInProcessRestart(getManagedUpdateOwner() ?? owner);
      }
      finishLoop(code);
      return;
    }
  };
  const handleHostedStopAfterServerClose = async (
    owner: HostLifecycle,
    shutdownFailure: GatewayShutdownFailure | undefined,
  ) => {
    await updateSuccessor.waitForStopSettlement();
    if (params.getHost() !== owner) {
      return;
    }
    params.setTerminalHostedStop(owner);
    try {
      if (shutdownFailure) {
        await forceExitAfterStabilityBundle("gateway.stop_close_failed", 1, shutdownFailure);
        return;
      }
      // This continuation belongs to the run loop, not to the closed kernel or
      // requesting lane. Native stop starts only after the existing joins.
      const result = await owner.finishStop();
      if (result.outcome === "retired" || params.getHost() !== owner) {
        return;
      }
      if (result.outcome !== "accepted" && result.outcome !== "exit") {
        gatewayLog.error(`Scheduled Gateway stop failed: ${result.detail}`);
        if (result.outcome === "refused") {
          params.setPendingRestartCompletion({
            outcome: "planned_restart",
            reason: "gateway.stop_refused",
          });
          await releaseLockIfHeld();
          if (params.getHost() === owner) {
            await reacquireAndResumeInProcessRestart();
          }
        } else {
          await forceExitAfterStabilityBundle("gateway.stop_native_unconfirmed");
        }
        return;
      }
      gatewayLog.info(
        result.outcome === "accepted"
          ? "Native service manager accepted Gateway stop"
          : "Gateway host completed graceful stop",
      );
      completeBoot({ outcome: "clean_stop", reason: "stop (hosted Gateway stop)" });
      await releaseLockIfHeld();
      await finishLoopAfterCleanup(0, undefined, "update", owner);
    } catch (error) {
      gatewayLog.error(`Scheduled Gateway stop failed: ${formatErrorMessage(error)}`);
      if (params.getHost() === owner) {
        await forceExitAfterStabilityBundle("gateway.stop_native_unconfirmed", 1, {
          step: "hosted-gateway-stop",
          error,
        });
      }
    } finally {
      if (params.getTerminalHostedStop() === owner) {
        params.setTerminalHostedStop(undefined);
      }
    }
  };

  return { finishLoopAfterCleanup, handleHostedStopAfterServerClose };
}
