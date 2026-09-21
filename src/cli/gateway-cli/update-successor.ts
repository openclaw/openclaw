import type { ChildProcess } from "node:child_process";
import { formatErrorMessage } from "../../infra/errors.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import type { ForegroundUpdateStop } from "../../infra/update-managed-service-handoff.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { sameManagedUpdateOwner, type GatewayRunSignalRequest } from "./run-loop-request.js";

export class GatewayUpdateSuccessor {
  private child: ChildProcess | true | null = null;
  private closed: Promise<void> | undefined;
  private foregroundStop?: {
    owner: ForegroundUpdateStop;
    confirmed: ReturnType<typeof createDeferredCore<void>>;
    onSettled: () => void;
    state: "waiting" | "joining" | "settled";
  };
  stopRequested = false;

  constructor(
    private readonly logger: Pick<SubsystemLogger, "info" | "warn" | "error">,
    private readonly lifecycle: Pick<
      typeof import("./lifecycle.runtime.js"),
      | "cancelManagedServiceUpdateHandoff"
      | "captureForegroundUpdateHandoffStop"
      | "completeForegroundUpdateHandoffAfterClose"
      | "markUpdateRestartSentinelFailure"
      | "readRestartSentinelReadOnly"
      | "writeRestartSentinelIfUnchanged"
      | "waitForGatewayHealthyRestart"
    >,
  ) {}

  get committed(): boolean {
    return this.child !== null;
  }

  get waitingForStop(): boolean {
    return this.foregroundStop !== undefined && this.foregroundStop.state !== "settled";
  }

  get capturedStop(): boolean {
    return this.foregroundStop !== undefined;
  }

  get running(): boolean {
    const child = this.child;
    return Boolean(
      child && child !== true && child.pid && child.exitCode === null && child.signalCode === null,
    );
  }

  commit(child: ChildProcess | true): void {
    if (this.child === child) {
      return;
    }
    this.child = child;
    if (child !== true) {
      this.closed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
    }
  }

  async observeReadiness(
    child: ChildProcess,
    params: {
      port?: number;
      host?: string;
      foreground: boolean;
      beforeWait: () => void;
      isCurrent: () => boolean;
    },
  ): Promise<boolean> {
    const updateSentinel = params.foreground
      ? null
      : await this.lifecycle.readRestartSentinelReadOnly();
    params.beforeWait();
    const health =
      typeof params.port === "number"
        ? await this.lifecycle.waitForGatewayHealthyRestart({
            port: params.port,
            child,
            probeHosts: [params.host ?? "127.0.0.1"],
            requireRunningService: true,
            requirePluginHealth: false,
          })
        : undefined;
    if (
      this.stopRequested ||
      (health?.waitOutcome !== "healthy" && health?.waitOutcome !== "still-starting")
    ) {
      return false;
    }
    this.commit(child);
    if (health.waitOutcome === "still-starting") {
      this.logger.warn("update respawn is still starting; leaving the replacement process running");
      if (
        params.isCurrent() &&
        updateSentinel?.payload.kind === "update" &&
        updateSentinel.payload.status !== "error"
      ) {
        await this.lifecycle
          .writeRestartSentinelIfUnchanged({
            payload: {
              ...updateSentinel.payload,
              status: "skipped",
              continuation: null,
              stats: { ...updateSentinel.payload.stats, reason: "still-starting" },
            },
            expectedRevision: updateSentinel.revision,
            isCurrent: params.isCurrent,
          })
          .catch((error: unknown) =>
            this.logger.warn(
              `failed to record pending update readiness: ${formatErrorMessage(error)}`,
            ),
          );
      }
    }
    return true;
  }

  stop(signal: "SIGINT" | "SIGTERM"): void {
    if (!this.stopRequested) {
      this.stopRequested = true;
      this.logger.info(`received ${signal}; stopping after foreground update settlement`);
      if (this.child && this.child !== true && this.running) {
        try {
          this.child.kill(signal);
        } catch (error) {
          this.logger.warn(`fresh Gateway stop signal failed: ${formatErrorMessage(error)}`);
        }
      }
    }
    this.joinForegroundStop();
  }

  private joinForegroundStop(): void {
    const pending = this.foregroundStop;
    if (!pending || pending.state !== "waiting") {
      return;
    }
    pending.state = "joining";
    void pending.owner
      .settle()
      .then((joined) => {
        if (!joined) {
          pending.state = "waiting";
          this.logger.error(
            "foreground update settlement unconfirmed; remaining draining; retry Stop after checking the updater",
          );
          return;
        }
        pending.state = "settled";
        pending.confirmed.resolve();
        pending.onSettled();
      })
      .catch((error: unknown) => {
        pending.state = "waiting";
        this.logger.error(`foreground update settlement failed: ${formatErrorMessage(error)}`);
      });
  }

  private retainForegroundStop(owner: ForegroundUpdateStop, onSettled: () => void): void {
    this.foregroundStop ??= {
      owner,
      confirmed: createDeferredCore(),
      onSettled,
      state: "waiting",
    };
  }

  async completeForegroundHandoffAfterClose(
    identity: NonNullable<GatewayRestartIntent["successorOwner"]>,
  ): Promise<{ respawn: boolean }> {
    const owner = this.lifecycle.captureForegroundUpdateHandoffStop({ onPark: () => {} });
    const completed = await this.lifecycle.completeForegroundUpdateHandoffAfterClose(identity);
    if (completed !== "pending") {
      return completed;
    }
    if (owner) {
      this.retainForegroundStop(owner, () => {});
    }
    const pending = this.foregroundStop;
    if (!pending) {
      throw new Error("foreground update settlement owner is unavailable; remaining draining");
    }
    await this.cancelHandoff(() => identity);
    this.joinForegroundStop();
    await pending.confirmed.promise;
    return { respawn: false };
  }

  async markHandoffUnavailable(
    foregroundClosed: boolean,
    reason = "restart-handoff-unavailable",
  ): Promise<void> {
    if (foregroundClosed) {
      return;
    }
    await this.lifecycle.markUpdateRestartSentinelFailure(reason).catch((error: unknown) => {
      this.logger.warn(`failed to mark update restart ${reason}: ${String(error)}`);
    });
  }

  handleSignal(
    request: Pick<GatewayRunSignalRequest, "action" | "signal" | "restartIntent">,
    foregroundActive: boolean | undefined,
    params: {
      beforeWait: () => void;
      onPark: (identity: NonNullable<GatewayRestartIntent["successorOwner"]>) => void;
      onSettled: () => void;
    },
  ): boolean {
    const { action, signal, restartIntent } = request;
    const successorOwner = restartIntent?.successorOwner;
    if (
      this.waitingForStop &&
      action !== "stop" &&
      (action !== "restart" ||
        !successorOwner ||
        !this.foregroundStop?.owner.canPark(successorOwner))
    ) {
      this.logger.info(
        `received ${signal}; ignoring restart while foreground update Stop is pending`,
      );
      return true;
    }
    if (action !== "stop" || signal === "SIGUSR2") {
      return false;
    }
    if (!foregroundActive && !this.waitingForStop) {
      if (this.foregroundStop) {
        return false;
      }
      const owner = this.lifecycle.captureForegroundUpdateHandoffStop({ onPark: params.onPark });
      if (!owner) {
        return false;
      }
      this.retainForegroundStop(owner, params.onSettled);
      params.beforeWait();
    }
    this.stop(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
    return true;
  }

  async cancelHandoff(
    getOwner: () => GatewayRestartIntent["successorOwner"],
    initialOwner = getOwner(),
  ): Promise<false | "restored-in-process" | "restart-after-exit"> {
    let owner = initialOwner;
    let requiresParentExit = false;
    try {
      for (;;) {
        if (!owner) {
          return requiresParentExit ? "restart-after-exit" : "restored-in-process";
        }
        const restoration = await this.lifecycle.cancelManagedServiceUpdateHandoff(owner);
        if (!restoration) {
          this.logger.error("managed update handoff cancellation unconfirmed; remaining draining");
          return false;
        }
        requiresParentExit ||= restoration === "restart-after-exit";
        const replacement = getOwner();
        if (!replacement || sameManagedUpdateOwner(owner, replacement)) {
          return requiresParentExit ? "restart-after-exit" : "restored-in-process";
        }
        owner = replacement;
      }
    } catch (err) {
      this.logger.error(`managed update handoff cancellation failed: ${formatErrorMessage(err)}`);
      return false;
    }
  }

  async cancel(): Promise<void> {
    const child = this.child;
    if (child && child !== true && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill("SIGTERM");
      } catch (error) {
        this.logger.warn(`fresh Gateway cancellation failed: ${formatErrorMessage(error)}`);
      }
    }
    await this.closed;
  }

  async waitForStopSettlement(): Promise<void> {
    if (this.stopRequested) {
      await this.foregroundStop?.confirmed.promise;
    }
  }

  async exit(code: number, exitProcess: (code: number) => void): Promise<void> {
    await this.waitForStopSettlement();
    const exitCode = code === 0 && !this.stopRequested && !this.running ? 1 : code;
    if (exitCode !== code) {
      this.logger.error("fresh Gateway stopped before handoff completed; check its startup logs");
    }
    if (this.stopRequested || exitCode !== 0) {
      await this.closed;
    }
    exitProcess(exitCode);
  }
}
